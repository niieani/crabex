import { parse } from "smol-toml";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import manifest from "./fixtures/browser-plugin.mcp.json";
import {
  BROWSER_WORKAROUND_ID,
  codexHomeForWorkaround,
  createBrowserWorkaroundSource,
  generateBrowserWorkaround,
  localBundleWithWorkaround,
  bundleServeMode,
} from "./browser-workaround.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function tempHome() {
  const path = await mkdtemp(join(tmpdir(), "crabex-browser-workaround-"));
  directories.push(path);
  return path;
}
describe("browser access workaround", () => {
  it("removes only the browser preload and round trips the Codex MCP configuration", () => {
    const result = generateBrowserWorkaround(manifest, "26.1023.50603");
    expect(result).toMatchObject({
      status: "active",
      version: "26.1023.50603",
      fragment: { id: BROWSER_WORKAROUND_ID },
    });
    const { cwd: _cwd, ...server } = manifest.mcpServers.cua_repl;
    expect(parse(result.fragment!.contents)).toEqual({
      mcp_servers: { cua_repl: { ...server, args: server.args.slice(2) } },
    });
  });
  it("reports not needed when no preload or cua_repl is present", () => {
    expect(generateBrowserWorkaround({}, "1").status).toBe("not needed");
    const next = structuredClone(manifest);
    next.mcpServers.cua_repl.args = ["--import", "/opt/example/other.mjs"];
    expect(generateBrowserWorkaround(next, "1")).toEqual({ status: "not needed", version: "1" });
  });
  it("selects the newest numeric version and regenerates after plugin changes", async () => {
    const home = await tempHome();
    const root = join(home, "plugins/cache/openai-bundled/unified-computer-use");
    for (const version of ["26.9.99999", "26.10.1", "26.2.1", "invalid"]) {
      await mkdir(join(root, version), { recursive: true });
      await writeFile(join(root, version, ".mcp.json"), JSON.stringify(manifest));
    }
    const source = createBrowserWorkaroundSource(home);
    expect(await source()).toMatchObject({ status: "active", version: "26.10.1" });
    await mkdir(join(root, "26.11.1"));
    await writeFile(join(root, "26.11.1", ".mcp.json"), JSON.stringify({ mcpServers: {} }));
    expect(await source()).toEqual({ status: "not needed", version: "26.11.1" });
  });
  it("reports missing plugins and missing manifests without touching the real home", async () => {
    const home = await tempHome();
    const source = createBrowserWorkaroundSource(home);
    expect(await source()).toEqual({ status: "plugin not found" });
    await mkdir(join(home, "plugins/cache/openai-bundled/unified-computer-use/1.0"), {
      recursive: true,
    });
    expect(await source()).toEqual({ status: "plugin not found" });
  });
  it("resolves CODEX_HOME before the config directory and the default home", () => {
    expect(codexHomeForWorkaround("/opt/example/config.toml", "/opt/env")).toBe("/opt/env");
    expect(codexHomeForWorkaround("/opt/example/config.toml", undefined)).toBe(
      process.env.CODEX_HOME ?? "/opt/example",
    );
    expect(codexHomeForWorkaround(undefined, "")).toBe("");
  });
  it("layers the workaround ahead of user fragments and ignores disabled user policy", () => {
    const workaround = generateBrowserWorkaround(manifest, "1");
    const bundle = {
      extra: true,
      config_toml: {
        enterprise_managed: [
          { id: BROWSER_WORKAROUND_ID, name: "collision", contents: "" },
          { id: "user", name: "User", contents: "" },
        ],
      },
    };
    expect(localBundleWithWorkaround({ version: 1, enabled: true, bundle }, workaround)).toEqual({
      extra: true,
      config_toml: {
        enterprise_managed: [workaround.fragment, bundle.config_toml.enterprise_managed[1]],
      },
    });
    expect(localBundleWithWorkaround({ version: 1, enabled: false, bundle }, workaround)).toEqual({
      config_toml: { enterprise_managed: [workaround.fragment] },
    });
    expect(bundleServeMode({ version: 1, enabled: false, mode: "replace", bundle })).toBe("merge");
  });
});
