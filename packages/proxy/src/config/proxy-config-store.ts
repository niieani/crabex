import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface ProxyConfig {
  version: 1;
  appsAuthRelay: boolean;
  search_broker: { route: string };
  routed_agents: { enabled: boolean; instructions?: string };
}

export const MAX_ROUTED_AGENT_INSTRUCTIONS = 1200;

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
        !(config.search_broker as { route: string }).route.trim())) ||
    (config.routed_agents !== undefined &&
      (typeof config.routed_agents !== "object" ||
        config.routed_agents === null ||
        Array.isArray(config.routed_agents) ||
        typeof (config.routed_agents as Record<string, unknown>).enabled !== "boolean"))
  ) {
    throw new Error(
      "invalid proxy config: expected version 1, boolean appsAuthRelay, search_broker.route, and boolean routed_agents.enabled",
    );
  }
  const instructions = (config.routed_agents as { instructions?: unknown } | undefined)
    ?.instructions;
  if (
    instructions !== undefined &&
    (typeof instructions !== "string" || instructions.length > MAX_ROUTED_AGENT_INSTRUCTIONS)
  )
    throw new Error(
      `invalid proxy config: routed_agents.instructions must be a string of at most ${MAX_ROUTED_AGENT_INSTRUCTIONS} characters`,
    );
  return {
    version: 1,
    appsAuthRelay: config.appsAuthRelay ?? true,
    search_broker: {
      route: (config.search_broker as { route: string } | undefined)?.route ?? "gpt-6-luna",
    },
    routed_agents: {
      enabled: (config.routed_agents as { enabled: boolean } | undefined)?.enabled ?? false,
      instructions: (instructions as string | undefined) ?? "",
    },
  };
}

export async function openProxyConfigStore(path: string): Promise<ProxyConfigStore> {
  let config: ProxyConfig = {
    version: 1,
    appsAuthRelay: true,
    search_broker: { route: "gpt-6-luna" },
    routed_agents: { enabled: false, instructions: "" },
  };
  try {
    config = parseProxyConfig(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  const listeners = new Set<() => void>();
  return {
    path,
    get: () => ({
      ...config,
      search_broker: { ...config.search_broker },
      routed_agents: { ...config.routed_agents },
    }),
    async replace(value) {
      const next = parseProxyConfig({
        ...value,
        search_broker: value.search_broker ?? config.search_broker,
        routed_agents: value.routed_agents ?? config.routed_agents,
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
