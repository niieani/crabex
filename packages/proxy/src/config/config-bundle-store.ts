import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface ConfigBundleOverride {
  version: 1;
  enabled: boolean;
  mode?: "replace" | "merge";
  bundle: unknown;
}

export const EMPTY_CONFIG_BUNDLE_OVERRIDE: ConfigBundleOverride = {
  version: 1,
  enabled: false,
  bundle: null,
};

export interface ConfigBundleStore {
  get(): ConfigBundleOverride;
  replace(override: ConfigBundleOverride): Promise<void>;
}

export async function openConfigBundleStore(filePath: string): Promise<ConfigBundleStore> {
  let initial = EMPTY_CONFIG_BUNDLE_OVERRIDE;
  try {
    initial = parseConfigBundleOverride(JSON.parse(await readFile(filePath, "utf8")));
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }
  return new FileConfigBundleStore(filePath, initial);
}

export function parseConfigBundleOverride(value: unknown): ConfigBundleOverride {
  const override = objectValue(value);
  if (override?.version !== 1 || typeof override.enabled !== "boolean") {
    throw new Error("unsupported config bundle override");
  }
  if (override.mode !== undefined && override.mode !== "replace" && override.mode !== "merge") {
    throw new Error("unsupported config bundle mode");
  }
  if (override.enabled && !isRecord(override.bundle)) {
    throw new Error("enabled config bundle override requires a JSON object bundle");
  }
  return structuredClone(override) as unknown as ConfigBundleOverride;
}

class FileConfigBundleStore implements ConfigBundleStore {
  #override: ConfigBundleOverride;
  readonly #filePath: string;

  constructor(filePath: string, initial: ConfigBundleOverride) {
    this.#filePath = filePath;
    this.#override = initial;
  }

  get(): ConfigBundleOverride {
    return structuredClone(this.#override);
  }

  async replace(value: ConfigBundleOverride): Promise<void> {
    const override = parseConfigBundleOverride(value);
    await mkdir(dirname(this.#filePath), { recursive: true });
    const temporaryPath = `${this.#filePath}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(override, null, 2)}\n`, { mode: 0o600 });
    await rename(temporaryPath, this.#filePath);
    this.#override = override;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/** Validate edits at the API boundary; old persisted files retain replace semantics. */
export function validateConfigBundleFragments(bundle: unknown): void {
  if (!isRecord(bundle)) return;
  for (const section of ["config_toml", "requirements_toml"]) {
    const value = bundle[section];
    if (value === null || value === undefined) continue;
    if (!isRecord(value)) throw new Error(`${section} must be an object or null`);
    const fragments = value.enterprise_managed;
    if (fragments === null || fragments === undefined) continue;
    if (!Array.isArray(fragments))
      throw new Error(`${section}.enterprise_managed must be an array or null`);
    const ids = new Set<string>();
    for (const fragment of fragments) {
      const item = objectValue(fragment);
      const label = `${section} fragment "${typeof item?.id === "string" ? item.id : "<invalid>"}"`;
      if (
        !item ||
        typeof item.id !== "string" ||
        item.id.trim() === "" ||
        typeof item.name !== "string" ||
        typeof item.contents !== "string"
      ) {
        throw new Error(`${label}: id must be non-empty; id, name and contents must be strings`);
      }
      if (ids.has(item.id)) throw new Error(`${label}: duplicate id`);
      ids.add(item.id);
      try {
        Bun.TOML.parse(item.contents);
      } catch (error) {
        throw new Error(`${label}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
}
