import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface ProxyConfig {
  version: 1;
  appsAuthRelay: boolean;
}

export interface ProxyConfigStore {
  readonly path: string;
  get(): ProxyConfig;
  replace(config: ProxyConfig): Promise<void>;
  subscribe(listener: () => void): () => void;
}

export function parseProxyConfig(value: unknown): ProxyConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("invalid proxy config");
  }
  const config = value as Record<string, unknown>;
  if (
    config.version !== 1 ||
    (config.appsAuthRelay !== undefined && typeof config.appsAuthRelay !== "boolean")
  ) {
    throw new Error("invalid proxy config: expected version 1 and a boolean appsAuthRelay");
  }
  return { version: 1, appsAuthRelay: config.appsAuthRelay ?? true } as ProxyConfig;
}

export async function openProxyConfigStore(path: string): Promise<ProxyConfigStore> {
  let config: ProxyConfig = { version: 1, appsAuthRelay: true };
  try {
    config = parseProxyConfig(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  const listeners = new Set<() => void>();
  return {
    path,
    get: () => ({ ...config }),
    async replace(value) {
      const next = parseProxyConfig(value);
      await mkdir(dirname(path), { recursive: true });
      const temporary = `${path}.${randomUUID()}.tmp`;
      await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
      await rename(temporary, path);
      config = next;
      for (const listener of listeners) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
