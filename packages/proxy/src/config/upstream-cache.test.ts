import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { openUpstreamCacheStore } from "./upstream-cache.ts";

describe("upstream cache store", () => {
  it("starts empty and persists observations atomically", async () => {
    const directory = await mkdtemp(join(tmpdir(), "act-upstream-cache-"));
    const path = join(directory, "upstream-cache.json");
    const store = await openUpstreamCacheStore(path);

    expect(store.get()).toEqual({});

    await store.observe("models", { models: [{ slug: "gpt-5.6-terra" }] });
    await store.observe("configBundle", { requirements_toml: null });

    const state = store.get();
    expect(state.models?.body).toEqual({ models: [{ slug: "gpt-5.6-terra" }] });
    expect(state.configBundle?.body).toEqual({ requirements_toml: null });
    expect(typeof state.models?.fetchedAt).toBe("string");

    const persisted = JSON.parse(await readFile(path, "utf8"));
    expect(persisted.models.body).toEqual({ models: [{ slug: "gpt-5.6-terra" }] });
    expect((await stat(path)).mode & 0o777).toBe(0o600);

    const reopened = await openUpstreamCacheStore(path);
    expect(reopened.get().configBundle?.body).toEqual({ requirements_toml: null });
  });

  it("replaces an earlier observation for the same kind", async () => {
    const directory = await mkdtemp(join(tmpdir(), "act-upstream-cache-"));
    const store = await openUpstreamCacheStore(join(directory, "cache.json"));

    await store.observe("models", { models: [{ slug: "a" }] });
    await store.observe("models", { models: [{ slug: "b" }] });

    expect(store.get().models?.body).toEqual({ models: [{ slug: "b" }] });
  });

  it("rejects malformed persisted state", async () => {
    const directory = await mkdtemp(join(tmpdir(), "act-upstream-cache-"));
    const path = join(directory, "cache.json");
    await Bun.write(path, '{"models":{"body":{}}}');

    await expect(openUpstreamCacheStore(path)).rejects.toThrow(
      "upstream cache models must have fetchedAt and body",
    );
  });
});
