import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmod,
  copyFile,
  cp,
  mkdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  resolveCustomCaSource,
  originalCodexCaValue,
  launchctlEnvironment,
  MANAGED_SERVICE_ENV,
  prepareCodexCaBundle,
  prepareTls,
  pruneCodexCaBundles,
  removeTls,
  syncPublishedCodexCa,
  syncCodexCaTransition,
  tlsStatus,
  type PublishedCodexCa,
} from "./tls.ts";
import { applyCodexConfigToggle, migrateCodexConfigFile } from "../config/codex-config.ts";
import { DATA_DIRECTORY, LEGACY_NAME } from "../config/legacy-migration.ts";
import { parseCliOptions } from "../cli/options.ts";
import { findUiDirectory } from "../api/web-ui.ts";

const LABEL = "com.crabex.proxy";
const ROOT = join(homedir(), "Library/Application Support/crabex");
const PLIST = join(homedir(), "Library/LaunchAgents", `${LABEL}.plist`);
const LOGS = join(homedir(), "Library/Logs/crabex");
const TLS_ROOT = join(ROOT, "tls");
const STATE = join(ROOT, "service.json");
const LOCK = join(ROOT, "operation.lock");
const TARGET = `gui/${process.getuid?.()}/${LABEL}`;
// An installation under the former name is migrated by the next `service install`.
const LEGACY_LABEL = `com.${LEGACY_NAME}.proxy`;
const LEGACY_ROOT = join(homedir(), "Library/Application Support", LEGACY_NAME);
const LEGACY_PLIST = join(homedir(), "Library/LaunchAgents", `${LEGACY_LABEL}.plist`);
const LEGACY_LOGS = join(homedir(), "Library/Logs", LEGACY_NAME);
const LEGACY_TARGET = `gui/${process.getuid?.()}/${LEGACY_LABEL}`;
// Copied once from the legacy root; releases, launchers, and state are rebuilt.
const LEGACY_SKIPPED = new Set(["releases", "bin", "current", "service.json", "operation.lock"]);

interface ServiceState {
  release: string;
  args: string[];
  environment: Record<string, string>;
  origin: string;
  desktopCodexCa?: PublishedCodexCa;
}

export function xml(value: string): string {
  return value.replace(/[<>&"']/g, (character) => {
    return { "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" }[character]!;
  });
}

export function launchAgentPlist(state: ServiceState, root = ROOT, logs = LOGS): string {
  const args = [join(state.release, "bun"), join(state.release, "cli.mjs"), ...state.args];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${LABEL}</string>
<key>ProgramArguments</key><array>${args.map((arg) => `<string>${xml(arg)}</string>`).join("")}</array>
<key>WorkingDirectory</key><string>${xml(root)}</string>
<key>EnvironmentVariables</key><dict>${Object.entries({
    ...state.environment,
    [MANAGED_SERVICE_ENV]: "1",
  })
    .map(([key, value]) => `<key>${xml(key)}</key><string>${xml(value)}</string>`)
    .join("")}</dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>5</integer>
<key>Umask</key><integer>63</integer>
<key>StandardOutPath</key><string>${xml(join(logs, "proxy.log"))}</string>
<key>StandardErrorPath</key><string>${xml(join(logs, "proxy-error.log"))}</string>
</dict></plist>\n`;
}

export function installArguments(args: string[], cwd: string, data: string): string[] {
  const parsed = parseCliOptions(["proxy", ...args]);
  if (!["127.0.0.1", "localhost", "::1"].includes(parsed.host)) {
    throw new Error("Service installation requires a loopback listener");
  }
  const paths = {
    "--config": parsed.configPath,
    "--captures": parsed.capturesDirectory,
    "--transformations": parsed.transformationsPath,
    "--model-routes": parsed.modelRoutesPath,
    "--config-bundle": parsed.configBundlePath,
    "--codex-config": parsed.codexConfigPath,
    "--upstream-cache": parsed.upstreamCachePath,
    "--stats": parsed.statsPath,
    "--snapshot-cache": parsed.snapshotCachePath,
  };
  const result = ["proxy", ...args];
  if (parsed.tlsDirectory) result.push("--tls-dir", resolve(cwd, parsed.tlsDirectory));
  for (const [flag, path] of Object.entries(paths)) {
    const explicit = args.includes(flag);
    const absolute =
      !explicit && path.startsWith(`${DATA_DIRECTORY}/`)
        ? join(data, path.slice(`${DATA_DIRECTORY}/`.length))
        : resolve(cwd, path);
    result.push(flag, absolute);
  }
  return result;
}

function withoutOptions(args: string[], names: readonly string[]): string[] {
  const result: string[] = [];
  for (let index = 0; index < args.length; index++) {
    if (names.includes(args[index]!)) {
      index += 1;
      continue;
    }
    result.push(args[index]!);
  }
  return result;
}

export class LaunchctlError extends Error {
  readonly command: string;
  readonly status: number | null;
  constructor(command: string, status: number | null, detail: string) {
    super(`launchctl ${command} failed (${status}): ${detail}`);
    this.command = command;
    this.status = status;
  }
}

// bootout can return while launchd is still removing the old job. A valid
// replacement then receives EIO (5); allow teardown to settle before rollback.
export async function bootstrapWithRetry(
  bootstrap: () => void,
  sleep: (ms: number) => Promise<unknown> = (ms) => Bun.sleep(ms),
): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      bootstrap();
      return;
    } catch (error) {
      if (
        !(error instanceof LaunchctlError) ||
        error.command !== "bootstrap" ||
        error.status !== 5 ||
        attempt === 20
      )
        throw error;
      await sleep(250);
    }
  }
}

function ctl(...args: string[]): string {
  const result = spawnSync("/bin/launchctl", args, { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new LaunchctlError(args[0]!, result.status, result.stderr.trim());
  return result.stdout;
}

async function state(path = STATE): Promise<ServiceState | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as ServiceState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function save(path: string, value: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, value, { mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function ready(origin: string, tlsDirectory?: string): Promise<boolean> {
  // A rollback to a release from before the rename serves the legacy API prefix.
  for (const prefix of ["crabex", LEGACY_NAME]) {
    try {
      const response = await fetch(`${origin}/__${prefix}/api/proxy-config`, {
        signal: AbortSignal.timeout(1000),
        ...(tlsDirectory
          ? { tls: { ca: await readFile(join(tlsDirectory, "ca.pem"), "utf8") } }
          : {}),
      });
      const config = (await response.json()) as { version?: number; appsAuthRelay?: boolean };
      if (response.ok && config.version === 1 && typeof config.appsAuthRelay === "boolean")
        return true;
    } catch {
      /* try the next prefix */
    }
  }
  return false;
}

async function waitReady(origin: string, tlsDirectory?: string): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt++) {
    let ownsPort = false;
    try {
      const pid = /^\s*pid = (\d+)$/m.exec(ctl("print", TARGET))?.[1];
      if (pid) {
        const listeners = spawnSync(
          "/usr/sbin/lsof",
          ["-nP", `-iTCP:${new URL(origin).port}`, "-sTCP:LISTEN", "-t"],
          { encoding: "utf8" },
        );
        ownsPort = listeners.stdout?.trim().split(/\s+/).includes(pid) ?? false;
      }
    } catch {
      /* launchd may still be starting the process */
    }
    if (ownsPort && (await ready(origin, tlsDirectory))) return;
    await Bun.sleep(500);
  }
  throw new Error("Proxy did not become ready within the startup deadline");
}

async function ensurePortFree(origin: string): Promise<void> {
  const url = new URL(origin);
  // Bind rather than treating an unrelated HTTP service as our own proxy.
  const server = Bun.serve({
    hostname: url.hostname.replace(/^\[|\]$/g, ""),
    port: Number(url.port),
    fetch: () => new Response(),
  });
  await server.stop(true);
}

async function unload(target = TARGET): Promise<void> {
  try {
    ctl("print", target);
  } catch {
    return;
  }
  ctl("bootout", target);
}

interface Operation {
  next: ServiceState;
  previous?: ServiceState;
  configUpdate?: { path: string; before: string | null; after: string };
  /** `previous` is the legacy installation, still running from LEGACY_ROOT. */
  legacy?: boolean;
}

/** Points a legacy service's paths at their copies in the new root. */
export function relocateServiceState(
  state: ServiceState,
  from = LEGACY_ROOT,
  to = ROOT,
): ServiceState {
  const relocate = (value: unknown): unknown => {
    if (typeof value === "string")
      return value === from || value.startsWith(`${from}/`) ? to + value.slice(from.length) : value;
    if (Array.isArray(value)) return value.map(relocate);
    if (typeof value === "object" && value !== null)
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, relocate(item)]));
    return value;
  };
  return relocate(state) as ServiceState;
}

async function copyLegacyRoot(): Promise<void> {
  await cp(LEGACY_ROOT, ROOT, {
    recursive: true,
    force: true,
    filter: (source) => {
      const relative = source.slice(LEGACY_ROOT.length + 1);
      return !LEGACY_SKIPPED.has(relative.split("/")[0]!);
    },
  });
}

export async function activateWithRollback(
  operation: Operation,
  actions: {
    activate(candidate: ServiceState): Promise<void>;
    persist(candidate: ServiceState): Promise<void>;
    remove(): Promise<void>;
  },
): Promise<void> {
  try {
    await actions.activate(operation.next);
    await actions.persist(operation.next);
  } catch (error) {
    if (operation.previous) {
      await actions.activate(operation.previous);
      await actions.persist(operation.previous);
      throw new Error(
        `Service update failed; previous service restored: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    await actions.remove();
    throw error;
  }
}

// Runs in a detached process, with file-backed output, before stopping any proxy.
async function worker(operationPath: string): Promise<void> {
  const operation = JSON.parse(await readFile(operationPath, "utf8")) as Operation;
  await save(`${operationPath}.started`, String(process.pid));
  // The caller confirms it received the acknowledgement before we touch launchd.
  for (let attempt = 0; ; attempt++) {
    if (await Bun.file(`${operationPath}.proceed`).exists()) break;
    if (attempt === 200)
      throw new Error("Restart was not acknowledged by caller; service left running");
    await Bun.sleep(50);
  }
  try {
    await activateWithRollback(operation, {
      activate: async (candidate) => {
        if (operation.legacy) {
          await unload(LEGACY_TARGET);
          await rm(LEGACY_PLIST, { force: true });
          // Data written after install copied it, until the legacy proxy stopped.
          if (candidate === operation.next)
            await cp(join(LEGACY_ROOT, "data"), join(ROOT, "data"), {
              recursive: true,
              force: true,
            }).catch((error: NodeJS.ErrnoException) => {
              if (error.code !== "ENOENT") throw error;
            });
        }
        await unload();
        await save(PLIST, launchAgentPlist(candidate));
        await bootstrapWithRetry(() => ctl("bootstrap", `gui/${process.getuid?.()}`, PLIST));
        await waitReady(candidate.origin, parseCliOptions(candidate.args).tlsDirectory);
      },
      persist: async (candidate) => {
        const managed = operation.next.desktopCodexCa;
        if (managed !== undefined)
          syncCodexCaTransition(
            managed,
            operation.previous?.desktopCodexCa,
            candidate === operation.next,
          );
        if (operation.configUpdate)
          await updateServiceCodexConfig(operation.configUpdate, candidate === operation.next);
        const temporary = join(ROOT, `current-${randomUUID()}`);
        await symlink(candidate.release, temporary);
        await rename(temporary, join(ROOT, "current"));
        await save(STATE, JSON.stringify(candidate, null, 2));
        if (candidate === operation.next) {
          try {
            await pruneCodexCaBundles(TLS_ROOT, [
              candidate.desktopCodexCa?.path,
              candidate.desktopCodexCa?.previous,
              candidate.desktopCodexCa?.source,
              operation.previous?.desktopCodexCa?.path,
              operation.previous?.desktopCodexCa?.previous,
              operation.previous?.desktopCodexCa?.source,
            ]);
          } catch (error) {
            console.warn(
              `Could not prune managed Codex CA bundles: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
      },
      remove: async () => {
        if (operation.next.desktopCodexCa !== undefined)
          syncPublishedCodexCa(operation.next.desktopCodexCa, false);
        if (operation.configUpdate) await updateServiceCodexConfig(operation.configUpdate, false);
        await unload();
        await rm(PLIST, { force: true });
      },
    });
    if (operation.legacy) {
      await rm(LEGACY_ROOT, { recursive: true, force: true });
      await rm(LEGACY_LOGS, { recursive: true, force: true });
      console.log(`Migrated legacy ${LEGACY_LABEL} service; removed ${LEGACY_ROOT}`);
    }
    console.log("Service ready", operation.next.origin);
  } finally {
    await rm(LOCK, { recursive: true, force: true });
  }
}

async function schedule(operation: Operation): Promise<void> {
  const path = join(LOGS, `restart-${Date.now()}.json`);
  await save(path, JSON.stringify(operation));
  const logPath = `${path}.log`;
  // A separate process session with file-backed output survives caller disconnects.
  const { openSync, closeSync } = await import("node:fs");
  const output = openSync(logPath, "a", 0o600);
  const child = spawn(
    join(operation.next.release, "bun"),
    [join(operation.next.release, "cli.mjs"), "service", "_worker", path],
    {
      detached: true,
      stdio: ["ignore", output, output],
      cwd: ROOT,
    },
  );
  closeSync(output);
  child.unref();
  let spawnError: Error | undefined;
  child.on("error", (error) => {
    spawnError = error;
  });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (spawnError) throw spawnError;
    if (await Bun.file(`${path}.started`).exists()) {
      await save(`${path}.proceed`, "acknowledged\n");
      console.log(`Independent restart worker started. Result log: ${path}.log`);
      return;
    }
    await Bun.sleep(50);
  }
  child.kill("SIGTERM");
  throw new Error(`Restart worker did not acknowledge startup; inspect ${path}.log`);
}

async function optionalText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function updateServiceCodexConfig(
  update: { path: string; before: string | null; after: string },
  forward: boolean,
): Promise<void> {
  const current = await optionalText(update.path);
  if (forward) {
    if (current !== update.before)
      throw new Error("Codex config changed during installation; service update cancelled");
    await save(update.path, update.after);
  } else if (current === update.after) {
    if (update.before === null) await rm(update.path, { force: true });
    else await save(update.path, update.before);
  }
}

export function serviceOrigin(args: string[]): string {
  const parsed = parseCliOptions(args);
  return `${parsed.tlsDirectory ? "https" : "http"}://${parsed.host === "::1" ? "[::1]" : parsed.host}:${parsed.port}`;
}

export async function serviceCommand(args: string[]): Promise<void> {
  if (process.platform !== "darwin")
    throw new Error("Service commands currently support macOS only");
  const [command, ...rest] = args;
  if (command === "_worker") {
    await worker(rest[0]!);
    return;
  }
  if (!["install", "uninstall", "status", "restart", "logs", "tls"].includes(command ?? "")) {
    throw new Error("Expected service install|uninstall|status|restart|logs|tls");
  }
  if (command !== "install" && command !== "tls" && rest.length)
    throw new Error(`service ${command} takes no options`);
  if (command === "tls" && (rest.length !== 1 || !["status", "renew", "remove"].includes(rest[0]!)))
    throw new Error("Usage: service tls status|renew|remove");
  if (command === "tls" && rest[0] === "status") {
    const installed = await state();
    console.log(
      JSON.stringify(
        await tlsStatus(installed ? parseCliOptions(installed.args).tlsDirectory : undefined),
        null,
        2,
      ),
    );
    return;
  }
  const legacyHint = async () =>
    (await state(join(LEGACY_ROOT, "service.json")))
      ? `; a ${LEGACY_LABEL} service exists, run service install to migrate it`
      : "";
  if (command === "status") {
    const installed = await state();
    if (!installed) {
      console.log(`Service is not installed${await legacyHint()}`);
      return;
    }
    const details = ctl("print", TARGET);
    console.log(
      details
        .split("\n")
        .filter((line) => /^\s*(state|pid|last exit code) =/.test(line))
        .join("\n"),
    );
    console.log(
      `HTTP readiness: ${(await ready(installed.origin, parseCliOptions(installed.args).tlsDirectory)) ? "ready" : "unavailable"}`,
    );
    return;
  }
  if (command === "logs") {
    for (const name of ["proxy.log", "proxy-error.log"]) {
      console.log(`\n${join(LOGS, name)}`);
      const result = spawnSync("/usr/bin/tail", ["-n", "80", join(LOGS, name)], {
        encoding: "utf8",
      });
      process.stdout.write(result.stdout ?? "");
    }
    console.log(`Restart result logs: ${LOGS}/restart-*.json.log`);
    return;
  }
  await mkdir(ROOT, { recursive: true, mode: 0o700 });
  await mkdir(LOGS, { recursive: true, mode: 0o700 });
  await mkdir(dirname(PLIST), { recursive: true });
  await mkdir(LOCK).catch(() => {
    throw new Error(
      `Another service operation is active. Inspect ${LOGS} before removing a stale lock: ${LOCK}`,
    );
  });
  let scheduled = false;
  try {
    const previous = await state();
    if (command === "uninstall") {
      if (!previous) {
        console.log(`Service is not installed${await legacyHint()}`);
        return;
      }
      await unload();
      await rm(PLIST, { force: true });
      if (previous.desktopCodexCa !== undefined)
        syncPublishedCodexCa(previous.desktopCodexCa, false);
      await removeTls(TLS_ROOT);
      await rm(STATE, { force: true });
      console.log(`Service removed; data and logs retained in ${ROOT} and ${LOGS}`);
      return;
    }
    if (command === "tls") {
      if (rest[0] === "remove") {
        if (previous && parseCliOptions(previous.args).tlsDirectory)
          throw new Error("Uninstall the HTTPS service before removing its certificates");
        await removeTls(TLS_ROOT);
        console.log("Managed TLS certificates and login Keychain trust removed");
        return;
      }
      if (!previous || !parseCliOptions(previous.args).tlsDirectory)
        throw new Error("Install with --https before renewing TLS");
      const directory = await prepareTls(TLS_ROOT, undefined, true);
      const args = [...withoutOptions(previous.args, ["--tls-dir"]), "--tls-dir", directory];
      await schedule({ next: { ...previous, args }, previous });
      scheduled = true;
      return;
    }
    if (command === "restart") {
      if (!previous) throw new Error(`Service is not installed${await legacyHint()}`);
      await schedule({ next: previous, previous });
      scheduled = true;
      return;
    }
    // A rolled-back migration leaves the legacy release installed; migrate it again.
    const legacy = previous
      ? previous.release.startsWith(`${LEGACY_ROOT}/`)
        ? previous
        : undefined
      : await state(join(LEGACY_ROOT, "service.json"));
    if (legacy) {
      if (await Bun.file(join(LEGACY_ROOT, "operation.lock")).exists())
        throw new Error(`A legacy service operation is active; inspect ${LEGACY_LOGS}`);
      await copyLegacyRoot();
      console.log(`Copied legacy service data from ${LEGACY_ROOT}`);
    }
    // Settings come from the installed service, or a relocated copy of the legacy one.
    const base = legacy ? relocateServiceState(legacy) : previous;
    if (!previous) {
      let registered = false;
      try {
        ctl("print", TARGET);
        registered = true;
      } catch {
        /* not registered */
      }
      if (registered)
        throw new Error(
          "A LaunchAgent with this label already exists outside this installation; left unchanged",
        );
    }
    const separator = rest.indexOf("--");
    const flags = separator < 0 ? rest : rest.slice(0, separator);
    const proxyArgs = separator < 0 ? [] : rest.slice(separator + 1);
    const environment = {
      HOME: homedir(),
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      ...base?.environment,
    };
    let https = false;
    for (let index = 0; index < flags.length; index += 2) {
      if (flags[index] === "--https") {
        https = true;
        index -= 1;
        continue;
      }
      const name = flags[index + 1];
      if (flags[index] !== "--env" || !name || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        throw new Error("Usage: service install [--https] [--env NAME]... [-- proxy options]");
      }
      const value = process.env[name];
      if (value === undefined) throw new Error(`Environment variable ${name} is not set`);
      Object.assign(environment, { [name]: value });
    }
    const data = join(ROOT, "data");
    let launchArgs =
      base && separator < 0 ? base.args : installArguments(proxyArgs, process.cwd(), data);
    if (proxyArgs.includes("--tls-dir"))
      throw new Error(
        "Use service install --https for managed certificates, or proxy --tls-dir for custom certificates",
      );
    const existingTls = base ? parseCliOptions(base.args).tlsDirectory : undefined;
    launchArgs = withoutOptions(launchArgs, ["--tls-dir", "--codex-ca-bundle"]);
    const parsed = parseCliOptions(launchArgs);
    if (parsed.port === 0) throw new Error("Service requires a fixed port");
    const origin = serviceOrigin(
      https || existingTls ? [...launchArgs, "--tls-dir", existingTls ?? TLS_ROOT] : launchArgs,
    );
    if (!base || new URL(base.origin).host !== new URL(origin).host) {
      await ensurePortFree(origin).catch(() => {
        throw new Error(
          `Port is occupied at ${origin}. Existing unmanaged proxies are left running; migrate using an independent restart script or choose another --listen port.`,
        );
      });
    }
    if (https || existingTls) {
      const directory = await prepareTls(TLS_ROOT, existingTls);
      launchArgs = [...launchArgs, "--tls-dir", directory];
    }
    const inheritedEnvironment = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    );
    const customCaBundle =
      https || existingTls
        ? resolveCustomCaSource(TLS_ROOT, [environment, inheritedEnvironment], base?.desktopCodexCa)
        : undefined;
    const codexCaBundle =
      (https || existingTls) && customCaBundle !== undefined
        ? await prepareCodexCaBundle(TLS_ROOT, customCaBundle)
        : base?.desktopCodexCa?.path;
    let desktopCodexCa: PublishedCodexCa | undefined;
    if (codexCaBundle !== undefined) {
      launchArgs = [...launchArgs, "--codex-ca-bundle", codexCaBundle];
      const prior = originalCodexCaValue(
        TLS_ROOT,
        base?.desktopCodexCa === undefined
          ? launchctlEnvironment().get("CODEX_CA_CERTIFICATE")
          : undefined,
        base?.desktopCodexCa,
      );
      desktopCodexCa = {
        path: codexCaBundle,
        ...(prior === undefined ? {} : { previous: prior }),
        ...(customCaBundle === undefined ? {} : { source: customCaBundle }),
      };
    }
    if (!(await Bun.file(join(data, ".migrated")).exists())) {
      const source = resolve(DATA_DIRECTORY);
      if (source !== data) {
        try {
          await cp(source, data, { recursive: true, force: false, errorOnExist: true });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      await mkdir(data, { recursive: true, mode: 0o700 });
      await save(join(data, ".migrated"), "Imported existing default proxy data\n");
    }
    const release = join(ROOT, "releases", randomUUID());
    const uiDirectory = await findUiDirectory(dirname(resolve(process.argv[1]!)));
    if (!uiDirectory)
      throw new Error("Build the Crabex UI with vp run build before installing the service");
    await mkdir(release, { recursive: true, mode: 0o700 });
    await cp(uiDirectory, join(release, "ui"), { recursive: true });
    const build = await Bun.build({
      entrypoints: [resolve(process.argv[1]!)],
      outdir: release,
      naming: "cli.mjs",
      target: "bun",
    });
    if (!build.success)
      throw new Error(
        `Service bundle failed: ${build.logs.map((entry) => entry.message).join("\n")}`,
      );
    await copyFile(process.execPath, join(release, "bun"));
    await chmod(join(release, "bun"), 0o700);
    const smoke = spawnSync(join(release, "bun"), [join(release, "cli.mjs"), "--help"], {
      encoding: "utf8",
    });
    if (smoke.status !== 0) throw new Error("Installed runtime failed its startup check");
    const bin = join(ROOT, "bin");
    await mkdir(bin, { recursive: true });
    const launcher = join(bin, "crabex");
    await save(
      launcher,
      '#!/bin/sh\nroot=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd) || exit 1\nexec "$root/current/bun" "$root/current/cli.mjs" "$@"\n',
    );
    await chmod(launcher, 0o700);
    let configUpdate: Operation["configUpdate"];
    // Before snapshotting: the new proxy would otherwise rewrite it during startup.
    const configNotice = await migrateCodexConfigFile(parsed.codexConfigPath);
    if (configNotice) console.log(configNotice);
    if (https) {
      const before = await optionalText(parsed.codexConfigPath);
      Bun.TOML.parse(before ?? "");
      let after = before ?? "";
      after = applyCodexConfigToggle(after, "openai_base_url", `${origin}/backend-api/codex`, true);
      after = applyCodexConfigToggle(after, "chatgpt_base_url", `${origin}/backend-api`, true);
      await mkdir(dirname(parsed.codexConfigPath), { recursive: true });
      configUpdate = { path: parsed.codexConfigPath, before, after };
    }
    await schedule({
      next: {
        release,
        args: launchArgs,
        environment,
        origin,
        ...(desktopCodexCa === undefined ? {} : { desktopCodexCa }),
      },
      previous: previous ?? legacy,
      configUpdate,
      ...(legacy ? { legacy: true } : {}),
    });
    console.log(`Installed command: ${launcher}`);
    scheduled = true;
  } finally {
    if (!scheduled) await rm(LOCK, { recursive: true, force: true });
  }
}
