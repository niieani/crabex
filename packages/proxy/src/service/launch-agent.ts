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
import { parseCliOptions } from "../cli/options.ts";

const LABEL = "com.agent-context-trimmer.proxy";
const ROOT = join(homedir(), "Library/Application Support/agent-context-trimmer");
const PLIST = join(homedir(), "Library/LaunchAgents", `${LABEL}.plist`);
const LOGS = join(homedir(), "Library/Logs/agent-context-trimmer");
const STATE = join(ROOT, "service.json");
const LOCK = join(ROOT, "operation.lock");
const TARGET = `gui/${process.getuid?.()}/${LABEL}`;

interface ServiceState {
  release: string;
  args: string[];
  environment: Record<string, string>;
  origin: string;
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
<key>EnvironmentVariables</key><dict>${Object.entries(state.environment)
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
  for (const [flag, path] of Object.entries(paths)) {
    const explicit = args.includes(flag);
    const absolute =
      !explicit && path.startsWith(".agent-context-trimmer/")
        ? join(data, path.slice(".agent-context-trimmer/".length))
        : resolve(cwd, path);
    result.push(flag, absolute);
  }
  return result;
}

function ctl(...args: string[]): string {
  const result = spawnSync("/bin/launchctl", args, { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`launchctl ${args[0]} failed: ${result.stderr.trim()}`);
  return result.stdout;
}

async function state(): Promise<ServiceState | undefined> {
  try {
    return JSON.parse(await readFile(STATE, "utf8")) as ServiceState;
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

async function ready(origin: string): Promise<boolean> {
  try {
    const response = await fetch(`${origin}/__agent-context-trimmer/api/proxy-config`, {
      signal: AbortSignal.timeout(1000),
    });
    const config = (await response.json()) as { version?: number; appsAuthRelay?: boolean };
    return response.ok && config.version === 1 && typeof config.appsAuthRelay === "boolean";
  } catch {
    return false;
  }
}

async function waitReady(origin: string): Promise<void> {
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
    if (ownsPort && (await ready(origin))) return;
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

async function unload(): Promise<void> {
  try {
    ctl("print", TARGET);
  } catch {
    return;
  }
  ctl("bootout", TARGET);
}

interface Operation {
  next: ServiceState;
  previous?: ServiceState;
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
      throw new Error("Service update failed; previous service restored", { cause: error });
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
        await unload();
        await save(PLIST, launchAgentPlist(candidate));
        ctl("bootstrap", `gui/${process.getuid?.()}`, PLIST);
        await waitReady(candidate.origin);
      },
      persist: async (candidate) => {
        const temporary = join(ROOT, `current-${randomUUID()}`);
        await symlink(candidate.release, temporary);
        await rename(temporary, join(ROOT, "current"));
        await save(STATE, JSON.stringify(candidate, null, 2));
      },
      remove: async () => {
        await unload();
        await rm(PLIST, { force: true });
      },
    });
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

export async function serviceCommand(args: string[]): Promise<void> {
  if (process.platform !== "darwin")
    throw new Error("Service commands currently support macOS only");
  const [command, ...rest] = args;
  if (command === "_worker") {
    await worker(rest[0]!);
    return;
  }
  if (!["install", "uninstall", "status", "restart", "logs"].includes(command ?? "")) {
    throw new Error("Expected service install|uninstall|status|restart|logs");
  }
  if (command !== "install" && rest.length) throw new Error(`service ${command} takes no options`);
  if (command === "status") {
    const installed = await state();
    if (!installed) {
      console.log("Service is not installed");
      return;
    }
    const details = ctl("print", TARGET);
    console.log(
      details
        .split("\n")
        .filter((line) => /^\s*(state|pid|last exit code) =/.test(line))
        .join("\n"),
    );
    console.log(`HTTP readiness: ${(await ready(installed.origin)) ? "ready" : "unavailable"}`);
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
        console.log("Service is not installed");
        return;
      }
      await unload();
      await rm(PLIST, { force: true });
      await rm(STATE, { force: true });
      console.log(`Service removed; data and logs retained in ${ROOT} and ${LOGS}`);
      return;
    }
    if (command === "restart") {
      if (!previous) throw new Error("Service is not installed");
      await schedule({ next: previous, previous });
      scheduled = true;
      return;
    }
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
      ...previous?.environment,
    };
    for (let index = 0; index < flags.length; index += 2) {
      const name = flags[index + 1];
      if (flags[index] !== "--env" || !name || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        throw new Error("Usage: service install [--env NAME]... [-- proxy options]");
      }
      const value = process.env[name];
      if (value === undefined) throw new Error(`Environment variable ${name} is not set`);
      Object.assign(environment, { [name]: value });
    }
    const data = join(ROOT, "data");
    const launchArgs =
      previous && separator < 0 ? previous.args : installArguments(proxyArgs, process.cwd(), data);
    const parsed = parseCliOptions(launchArgs);
    if (parsed.port === 0) throw new Error("Service requires a fixed port");
    const origin = `http://${parsed.host === "::1" ? "[::1]" : parsed.host}:${parsed.port}`;
    if (!previous || previous.origin !== origin) {
      await ensurePortFree(origin).catch(() => {
        throw new Error(
          `Port is occupied at ${origin}. Existing unmanaged proxies are left running; migrate using an independent restart script or choose another --listen port.`,
        );
      });
    }
    if (!(await Bun.file(join(data, ".migrated")).exists())) {
      const source = resolve(".agent-context-trimmer");
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
    await mkdir(release, { recursive: true, mode: 0o700 });
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
    const launcher = join(bin, "agent-context-trimmer");
    await save(
      launcher,
      '#!/bin/sh\nroot=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd) || exit 1\nexec "$root/current/bun" "$root/current/cli.mjs" "$@"\n',
    );
    await chmod(launcher, 0o700);
    await schedule({ next: { release, args: launchArgs, environment, origin }, previous });
    console.log(`Installed command: ${launcher}`);
    scheduled = true;
  } finally {
    if (!scheduled) await rm(LOCK, { recursive: true, force: true });
  }
}
