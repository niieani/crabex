import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, copyFile, cp, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { findUiDirectory } from "../api/web-ui.ts";
import { parseCliOptions } from "../cli/options.ts";
import { applyCodexConfigToggle, migrateCodexConfigFile } from "../config/codex-config.ts";
import { DATA_DIRECTORY } from "../config/legacy-migration.ts";
import { inheritServiceCaEnvironment, serviceEnvironmentValue } from "./environment.ts";
import { copyLegacyRoot, relocateServiceState } from "./legacy.ts";
import type { ServiceManager } from "./manager.ts";
import { schedule, tlsRoot } from "./operation.ts";
import {
  installArguments,
  optionalText,
  readState,
  save,
  serviceOrigin,
  withoutOptions,
  type Operation,
  type ServiceState,
} from "./state.ts";
import {
  launchctlEnvironment,
  originalCodexCaValue,
  prepareCodexCaBundle,
  prepareTls,
  publishedCodexCaValue,
  resolveCustomCaSource,
  type PublishedCodexCa,
} from "./tls.ts";

const USAGE = "Usage: service install [--https] [--env NAME]... [-- proxy options]";

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

/** Builds a release from the running CLI and schedules its activation. Runs under the lock. */
export async function install(
  manager: ServiceManager,
  previous: ServiceState | undefined,
  rest: string[],
): Promise<void> {
  const tls = tlsRoot(manager);
  // A rolled-back migration leaves the legacy release installed; migrate it again.
  const legacyInstallation = manager.legacy;
  const legacy =
    legacyInstallation === undefined
      ? undefined
      : previous
        ? previous.release.startsWith(`${legacyInstallation.root}/`)
          ? previous
          : undefined
        : await readState(join(legacyInstallation.root, "service.json"));
  if (legacy && legacyInstallation) {
    if (await Bun.file(join(legacyInstallation.root, "operation.lock")).exists())
      throw new Error(`A legacy service operation is active; inspect ${legacyInstallation.logs}`);
    await copyLegacyRoot(legacyInstallation.root, manager.root);
    console.log(`Copied legacy service data from ${legacyInstallation.root}`);
  }
  // Settings come from the installed service, or a relocated copy of the legacy one.
  const base =
    legacy && legacyInstallation
      ? relocateServiceState(legacy, legacyInstallation.root, manager.root)
      : previous;
  if (!previous && manager.registered())
    throw new Error(
      `A ${manager.kind} with Crabex's name exists outside this installation; left unchanged`,
    );
  const separator = rest.indexOf("--");
  const flags = separator < 0 ? rest : rest.slice(0, separator);
  const proxyArgs = separator < 0 ? [] : rest.slice(separator + 1);
  const cwd = process.cwd();
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
    if (flags[index] !== "--env" || !name || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
      throw new Error(USAGE);
    const value = process.env[name];
    if (value === undefined) throw new Error(`Environment variable ${name} is not set`);
    Object.assign(environment, { [name]: serviceEnvironmentValue(name, value, cwd) });
  }
  if (https && !manager.supportsHttps)
    throw new Error(`A ${manager.kind} cannot manage local HTTPS; install without --https`);
  manager.preflight();
  const inheritedCaEnvironment = inheritServiceCaEnvironment(
    environment,
    base?.inheritedCaEnvironment,
    process.env,
    cwd,
  );
  const data = join(manager.root, "data");
  let launchArgs = base && separator < 0 ? base.args : installArguments(proxyArgs, cwd, data);
  if (proxyArgs.includes("--tls-dir"))
    throw new Error(
      "Use service install --https for managed certificates, or proxy --tls-dir for custom certificates",
    );
  const existingTls = base ? parseCliOptions(base.args).tlsDirectory : undefined;
  launchArgs = withoutOptions(launchArgs, ["--tls-dir", "--codex-ca-bundle"]);
  const parsed = parseCliOptions(launchArgs);
  if (parsed.port === 0) throw new Error("Service requires a fixed port");
  const origin = serviceOrigin(
    https || existingTls ? [...launchArgs, "--tls-dir", existingTls ?? tls] : launchArgs,
  );
  if (!base || new URL(base.origin).host !== new URL(origin).host) {
    await ensurePortFree(origin).catch(() => {
      throw new Error(
        `Port is occupied at ${origin}. Existing unmanaged proxies are left running; migrate using an independent restart script or choose another --listen port.`,
      );
    });
  }
  if (https || existingTls) {
    const directory = await prepareTls(tls, existingTls);
    launchArgs = [...launchArgs, "--tls-dir", directory];
  }
  const inheritedEnvironment = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  const customCaBundle =
    https || existingTls
      ? resolveCustomCaSource(tls, [environment, inheritedEnvironment], base?.desktopCodexCa)
      : undefined;
  const codexCaBundle =
    (https || existingTls) && customCaBundle !== undefined
      ? await prepareCodexCaBundle(tls, customCaBundle)
      : base?.desktopCodexCa?.path;
  let desktopCodexCa: PublishedCodexCa | undefined;
  if (codexCaBundle !== undefined) {
    launchArgs = [...launchArgs, "--codex-ca-bundle", codexCaBundle];
    const prior = originalCodexCaValue(
      tls,
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
  const release = await buildRelease(manager.root);
  const launcher = await writeLauncher(manager.root);
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
  await schedule(manager, {
    next: {
      release,
      args: launchArgs,
      environment,
      ...(Object.keys(inheritedCaEnvironment).length === 0 ? {} : { inheritedCaEnvironment }),
      origin,
      ...(desktopCodexCa === undefined ? {} : { desktopCodexCa }),
    },
    previous: previous ?? legacy,
    configUpdate,
    ...(legacy ? { legacy: true } : {}),
  });
  console.log(`Installed command: ${launcher}`);
  if (desktopCodexCa !== undefined) {
    const published = publishedCodexCaValue(desktopCodexCa.path);
    const shellPath = published.startsWith(`${homedir()}/`)
      ? `$HOME${published.slice(homedir().length)}`
      : published;
    console.log(
      `Codex CA bundle: ${published}\n` +
        "launchd forgets CODEX_CA_CERTIFICATE at logout; for terminal sessions, add to ~/.zshenv\n" +
        "(the guard skips the export after `service tls remove` deletes the bundle):\n" +
        `  [[ -e "${shellPath}" ]] &&\n` +
        `    export CODEX_CA_CERTIFICATE="${shellPath}"`,
    );
  }
}

/** Copies the UI, bundles the CLI and copies the Bun runtime into a new release directory. */
async function buildRelease(root: string): Promise<string> {
  const release = join(root, "releases", randomUUID());
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
  return release;
}

async function writeLauncher(root: string): Promise<string> {
  const bin = join(root, "bin");
  await mkdir(bin, { recursive: true });
  const launcher = join(bin, "crabex");
  await save(
    launcher,
    '#!/bin/sh\nroot=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd) || exit 1\nexec "$root/current/bun" "$root/current/cli.mjs" "$@"\n',
  );
  await chmod(launcher, 0o700);
  return launcher;
}
