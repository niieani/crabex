import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface ProxyConfig {
  version: 1;
  appsAuthRelay: boolean;
  search_broker: { route: string };
}

export interface ProxyConfigStore {
  readonly path: string;
  get(): ProxyConfig;
  replace(config: Partial<ProxyConfig> & Pick<ProxyConfig, "version">): Promise<void>;
  subscribe(listener: () => void): () => void;
}

export function parseProxyConfig(value: unknown): ProxyConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("invalid proxy config");
  }
  const config = value as Record<string, unknown>;
  if (
    config.version !== 1 ||
    (config.appsAuthRelay !== undefined && typeof config.appsAuthRelay !== "boolean") ||
    (config.search_broker !== undefined &&
      (typeof config.search_broker !== "object" ||
        config.search_broker === null ||
        Array.isArray(config.search_broker) ||
        typeof (config.search_broker as Record<string, unknown>).route !== "string" ||
        !(config.search_broker as { route: string }).route.trim()))
  ) {
    throw new Error(
      "invalid proxy config: expected version 1, boolean appsAuthRelay, and search_broker.route",
    );
  }
  return {
    version: 1,
    appsAuthRelay: config.appsAuthRelay ?? true,
    search_broker: {
      route: (config.search_broker as { route: string } | undefined)?.route ?? "gpt-6-luna",
    },
  };
}

export async function openProxyConfigStore(path: string): Promise<ProxyConfigStore> {
  let config: ProxyConfig = {
    version: 1,
    appsAuthRelay: true,
    search_broker: { route: "gpt-6-luna" },
  };
  try {
    config = parseProxyConfig(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  const listeners = new Set<() => void>();
  return {
    path,
    get: () => ({ ...config, search_broker: { ...config.search_broker } }),
    async replace(value) {
      const next = parseProxyConfig({
        ...value,
        search_broker: value.search_broker ?? config.search_broker,
      });
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
