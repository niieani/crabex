import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { parseListen } from "./listen-address.ts";

export interface ProxyConfig {
  version: 1;
  appsAuthRelay: boolean;
  /** Lets Advanced serve a local managed-policy bundle; only editable in the config file. */
  local_policy_override: boolean;
  search_broker: { route: string };
  routed_agents: {
    enabled: boolean;
    instructions?: string;
    prefer_native_spawn_models: boolean;
  };
  /** Lends this instance's ChatGPT login to other Codex instances. Off unless opted into. */
  shared_login: { enabled: boolean; listen: string };
}

const DEFAULT_SHARED_LOGIN: ProxyConfig["shared_login"] = {
  enabled: false,
  listen: "127.0.0.1:8766",
};

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
    (config.local_policy_override !== undefined &&
      typeof config.local_policy_override !== "boolean") ||
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
      "invalid proxy config: expected version 1, boolean appsAuthRelay, boolean local_policy_override, search_broker.route, and boolean routed_agents.enabled",
    );
  }
  const instructions = (config.routed_agents as { instructions?: unknown } | undefined)
    ?.instructions;
  const preferNativeSpawnModels = (
    config.routed_agents as { prefer_native_spawn_models?: unknown } | undefined
  )?.prefer_native_spawn_models;
  if (
    instructions !== undefined &&
    (typeof instructions !== "string" || instructions.length > MAX_ROUTED_AGENT_INSTRUCTIONS)
  )
    throw new Error(
      `invalid proxy config: routed_agents.instructions must be a string of at most ${MAX_ROUTED_AGENT_INSTRUCTIONS} characters`,
    );
  if (preferNativeSpawnModels !== undefined && typeof preferNativeSpawnModels !== "boolean")
    throw new Error(
      "invalid proxy config: routed_agents.prefer_native_spawn_models must be boolean",
    );
  return {
    version: 1,
    shared_login: parseSharedLogin(config.shared_login),
    appsAuthRelay: config.appsAuthRelay ?? true,
    local_policy_override: (config.local_policy_override as boolean | undefined) ?? false,
    search_broker: {
      route: (config.search_broker as { route: string } | undefined)?.route ?? "gpt-6-luna",
    },
    routed_agents: {
      enabled: (config.routed_agents as { enabled: boolean } | undefined)?.enabled ?? false,
      instructions: (instructions as string | undefined) ?? "",
      prefer_native_spawn_models: (preferNativeSpawnModels as boolean | undefined) ?? false,
    },
  };
}

function parseSharedLogin(value: unknown): ProxyConfig["shared_login"] {
  if (value === undefined) return { ...DEFAULT_SHARED_LOGIN };
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("invalid proxy config: shared_login must be an object");
  const { enabled, listen } = value as Record<string, unknown>;
  if (enabled !== undefined && typeof enabled !== "boolean")
    throw new Error("invalid proxy config: shared_login.enabled must be boolean");
  if (listen !== undefined && typeof listen !== "string")
    throw new Error("invalid proxy config: shared_login.listen must be host:port");
  if (typeof listen === "string") parseListen(listen, "shared_login.listen");
  return {
    enabled: enabled ?? DEFAULT_SHARED_LOGIN.enabled,
    listen: listen ?? DEFAULT_SHARED_LOGIN.listen,
  };
}

export async function openProxyConfigStore(path: string): Promise<ProxyConfigStore> {
  let config: ProxyConfig = {
    version: 1,
    appsAuthRelay: true,
    local_policy_override: false,
    search_broker: { route: "gpt-6-luna" },
    routed_agents: { enabled: false, instructions: "", prefer_native_spawn_models: false },
    shared_login: { ...DEFAULT_SHARED_LOGIN },
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
      shared_login: { ...config.shared_login },
    }),
    async replace(value) {
      const next = parseProxyConfig({
        ...value,
        search_broker: value.search_broker ?? config.search_broker,
        routed_agents: value.routed_agents ?? config.routed_agents,
        shared_login: value.shared_login ?? config.shared_login,
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
