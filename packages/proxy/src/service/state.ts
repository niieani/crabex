import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { parseCliOptions } from "../cli/options.ts";
import { DATA_DIRECTORY } from "../config/legacy-migration.ts";
import { MANAGED_SERVICE_ENV, type PublishedCodexCa } from "./tls.ts";

export interface ServiceState {
  release: string;
  args: string[];
  environment: Record<string, string>;
  inheritedCaEnvironment?: Record<string, string>;
  origin: string;
  desktopCodexCa?: PublishedCodexCa;
}

export interface Operation {
  next: ServiceState;
  previous?: ServiceState;
  configUpdate?: { path: string; before: string | null; after: string };
  /** `previous` is the legacy installation, still running from the legacy root. */
  legacy?: boolean;
}

export async function readState(path: string): Promise<ServiceState | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as ServiceState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** Writes a file readable only by the user, replacing it atomically. */
export async function save(path: string, value: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, value, { mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function optionalText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** The service environment: selected variables win over inherited CA settings. */
export function serviceEnvironment(state: ServiceState): [string, string][] {
  return Object.entries({
    ...state.inheritedCaEnvironment,
    ...state.environment,
    [MANAGED_SERVICE_ENV]: "1",
  });
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

export function withoutOptions(args: string[], names: readonly string[]): string[] {
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

export function serviceOrigin(args: string[]): string {
  const parsed = parseCliOptions(args);
  return `${parsed.tlsDirectory ? "https" : "http"}://${parsed.host === "::1" ? "[::1]" : parsed.host}:${parsed.port}`;
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
    try {
      await actions.remove();
    } catch (removeError) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}; removing the failed installation also failed: ${removeError instanceof Error ? removeError.message : String(removeError)}`,
        { cause: error },
      );
    }
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
