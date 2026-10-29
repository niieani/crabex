import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vite-plus/test";

import {
  EMPTY_CONFIG_BUNDLE_OVERRIDE,
  openConfigBundleStore,
  parseConfigBundleOverride,
} from "./config-bundle-store.ts";

describe("config bundle store", () => {
  it("starts disabled and atomically persists an override", async () => {
    const directory = await mkdtemp(join(tmpdir(), "act-bundle-"));
    const path = join(directory, "bundle.json");
    const store = await openConfigBundleStore(path);
    const override = {
      version: 1 as const,
      enabled: true,
      bundle: { config_toml: null, requirements_toml: null },
    };

    expect(store.get()).toEqual(EMPTY_CONFIG_BUNDLE_OVERRIDE);
    await store.replace(override);

    expect(store.get()).toEqual(override);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(override);
    expect((await openConfigBundleStore(path)).get()).toEqual(override);
  });

  it("rejects an enabled override without an object bundle", () => {
    expect(() => parseConfigBundleOverride({ version: 1, enabled: true, bundle: null })).toThrow(
      "enabled config bundle override requires a JSON object bundle",
    );
  });

  it("rejects malformed persisted configuration", async () => {
    const directory = await mkdtemp(join(tmpdir(), "act-bundle-"));
    const path = join(directory, "bundle.json");
    await Bun.write(path, '{"version":2,"enabled":false,"bundle":null}');

    await expect(openConfigBundleStore(path)).rejects.toThrow("unsupported config bundle override");
  });
});

it("supports optional modes without migrating legacy overrides", () => {
  const legacy = { version: 1, enabled: true, bundle: {} };
  expect(parseConfigBundleOverride(legacy)).toEqual(legacy);
  for (const mode of ["merge", "replace"])
    expect(parseConfigBundleOverride({ ...legacy, mode })).toEqual({ ...legacy, mode });
  expect(() => parseConfigBundleOverride({ ...legacy, mode: "other" })).toThrow("mode");
});
