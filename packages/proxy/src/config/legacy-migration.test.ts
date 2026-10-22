import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { applyCodexConfigToggle, migrateCodexConfigFile } from "./codex-config.ts";
import { migrateLocalDataDirectory } from "./legacy-migration.ts";

const LEGACY_CONFIG = `# >>> agent-context-trimmer:openai_base_url >>>
# openai_base_url = "https://example.com"
openai_base_url = "http://127.0.0.1:8765/backend-api/codex"
# <<< agent-context-trimmer:openai_base_url <<<
model = "gpt-5.6-luna"
`;

describe("legacy migration", () => {
  it("renames the local data directory once", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "crabex-migrate-"));
    await mkdir(join(cwd, ".agent-context-trimmer"));
    await writeFile(join(cwd, ".agent-context-trimmer", "config.json"), "{}");
    expect(await migrateLocalDataDirectory(cwd)).toContain("Migrated");
    expect(await readdir(cwd)).toEqual([".crabex"]);
    expect(await readFile(join(cwd, ".crabex", "config.json"), "utf8")).toBe("{}");
    expect(await migrateLocalDataDirectory(cwd)).toBeUndefined();
  });

  it("leaves both directories when the new one already exists", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "crabex-migrate-"));
    await mkdir(join(cwd, ".agent-context-trimmer"));
    await mkdir(join(cwd, ".crabex"));
    expect(await migrateLocalDataDirectory(cwd)).toContain("Both");
    expect((await readdir(cwd)).sort()).toEqual([".agent-context-trimmer", ".crabex"]);
  });

  it("renames managed Codex config fences in place", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "crabex-codex-")), "config.toml");
    await writeFile(path, LEGACY_CONFIG);
    expect(await migrateCodexConfigFile(path)).toContain("Renamed");
    expect(await readFile(path, "utf8")).toBe(
      LEGACY_CONFIG.replaceAll("agent-context-trimmer", "crabex"),
    );
    expect(await migrateCodexConfigFile(path)).toBeUndefined();
  });

  it("treats legacy fences as managed when toggling", () => {
    const disabled = applyCodexConfigToggle(LEGACY_CONFIG, "openai_base_url", "unused", false);
    expect(disabled).toBe('openai_base_url = "https://example.com"\nmodel = "gpt-5.6-luna"\n');
  });
});
