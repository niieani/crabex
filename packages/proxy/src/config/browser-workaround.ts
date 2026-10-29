import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ConfigBundleOverride } from "./config-bundle-store.ts";
import { mergeConfigBundles } from "./config-bundle-merge.ts";
import { isRecord, serializeToml } from "./toml-serialize.ts";

export const BROWSER_WORKAROUND_ID = "crabex-workaround-cua-repl-browser-access";
export interface BrowserWorkaround {
  status:
    | "disabled"
    | "plugin not found"
    | "not needed"
    | "active"
    | "plugin configuration unavailable";
  version?: string;
  fragment?: { id: string; name: string; contents: string };
}
export type BrowserWorkaroundSource = () => Promise<BrowserWorkaround>;

export function codexHomeForWorkaround(
  configPath?: string,
  environmentHome = process.env.CODEX_HOME,
): string {
  return environmentHome ?? (configPath ? dirname(configPath) : join(homedir(), ".codex"));
}

export function generateBrowserWorkaround(manifest: unknown, version: string): BrowserWorkaround {
  const servers = isRecord(manifest) && isRecord(manifest.mcpServers) ? manifest.mcpServers : {};
  const server = servers.cua_repl;
  if (!isRecord(server) || !Array.isArray(server.args)) return { status: "not needed", version };
  const args: unknown[] = [];
  let removed = false;
  for (let i = 0; i < server.args.length; i++) {
    const next: unknown = server.args[i + 1];
    if (
      server.args[i] === "--import" &&
      typeof next === "string" &&
      /(?:^|[/\\])require-browser-access\.mjs$/.test(next)
    ) {
      removed = true;
      i++;
    } else args.push(server.args[i]);
  }
  if (!removed) return { status: "not needed", version };
  const config: Record<string, unknown> = { args };
  // These are Codex McpServerConfig / stdio transport keys, not plugin-only metadata.
  for (const key of [
    "command",
    "cwd",
    "startup_timeout_sec",
    "enabled_tools",
    "env_vars",
    "tools",
    "env",
    "enabled",
    "omit_tools_from",
  ]) {
    if (server[key] !== undefined && server[key] !== null) config[key] = server[key];
  }
  return {
    status: "active",
    version,
    fragment: {
      id: BROWSER_WORKAROUND_ID,
      name: "Browser access workaround (openai/codex#57641)",
      contents: serializeToml({ mcp_servers: { cua_repl: config } }),
    },
  };
}

/** Read on every serve/preview, so a plugin update cannot leave stale paths behind. */
export function createBrowserWorkaroundSource(codexHome: string): BrowserWorkaroundSource {
  const root = join(codexHome, "plugins/cache/openai-bundled/unified-computer-use");
  return async () => {
    try {
      const entries = await readdir(root, { withFileTypes: true });
      const versions = entries
        .filter((entry) => entry.isDirectory() && /^\d+(\.\d+)*$/.test(entry.name))
        .map((entry) => entry.name);
      versions.sort((a, b) => {
        const left = a.split(".").map(BigInt),
          right = b.split(".").map(BigInt);
        for (let i = 0; i < Math.max(left.length, right.length); i++) {
          const diff = (right[i] ?? 0n) - (left[i] ?? 0n);
          if (diff !== 0n) return diff > 0n ? 1 : -1;
        }
        return b.localeCompare(a);
      });
      const version = versions[0];
      if (!version) return { status: "plugin not found" };
      const manifest: unknown = JSON.parse(
        await readFile(join(root, version, ".mcp.json"), "utf8"),
      );
      return generateBrowserWorkaround(manifest, version);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return { status: "plugin not found" };
      console.warn("browser access workaround plugin configuration unavailable");
      return { status: "plugin configuration unavailable" };
    }
  };
}

export async function resolveBrowserWorkaround(
  override: ConfigBundleOverride,
  source?: BrowserWorkaroundSource,
): Promise<BrowserWorkaround> {
  return override.workarounds?.cua_repl_browser_access
    ? ((await source?.()) ?? { status: "plugin not found" })
    : { status: "disabled" };
}

export function bundleServeMode(override: ConfigBundleOverride): "replace" | "merge" {
  return override.enabled ? (override.mode ?? "replace") : "merge";
}

export function localBundleWithWorkaround(
  override: ConfigBundleOverride,
  workaround: BrowserWorkaround,
): unknown {
  const local = override.enabled ? override.bundle : {};
  if (!workaround.fragment) return local;
  // Use the same merge rules: the generated fragment replaces even a user id collision.
  return mergeConfigBundles(local, { config_toml: { enterprise_managed: [workaround.fragment] } });
}
