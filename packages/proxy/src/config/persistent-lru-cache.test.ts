import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PersistentLruCache } from "./persistent-lru-cache.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function pathForTest(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "act-session-cache-"));
  directories.push(directory);
  return join(directory, "sessions.json");
}

const options = (now: () => number, warn: (message: string) => void = () => {}) => ({
  maxEntries: 2,
  maxBytes: 270,
  ttlMs: 1_000,
  now,
  warn,
  isValue: (value: unknown): value is { responseId: string } =>
    typeof value === "object" &&
    value !== null &&
    "responseId" in value &&
    typeof value.responseId === "string",
});

describe("persistent LRU cache", () => {
  it("restores recent entries after a new instance opens the same file without storing raw keys", async () => {
    const path = await pathForTest();
    const first = await PersistentLruCache.open(
      path,
      options(() => 100),
    );
    first.set("Bearer private-token, account-42", { responseId: "resp_1" });
    await first.flush();
    const file = await readFile(path, "utf8");
    expect(file).not.toContain("private-token");
    expect(file).not.toContain("account-42");
    const second = await PersistentLruCache.open(
      path,
      options(() => 200),
    );
    expect(second.get("Bearer private-token, account-42")).toEqual({ responseId: "resp_1" });
    await second.flush();
  });

  it("evicts the least recently used entry and enforces a total byte limit", async () => {
    const path = await pathForTest();
    const limits = { ...options(() => 0), maxEntries: 3 };
    const cache = await PersistentLruCache.open(path, limits);
    cache.set("a", { responseId: "a" });
    cache.set("b", { responseId: "b" });
    expect(cache.get("a")).toEqual({ responseId: "a" });
    cache.set("c", { responseId: "c" });
    expect(cache.get("b")).toBeUndefined();
    cache.set("oversized", { responseId: "x".repeat(200) });
    expect(cache.get("oversized")).toBeUndefined();
    await cache.flush();
    expect(Buffer.byteLength(await readFile(path))).toBeLessThanOrEqual(270);
    const reopened = await PersistentLruCache.open(path, limits);
    expect(reopened.get("a")).toEqual({ responseId: "a" });
    expect(reopened.get("c")).toEqual({ responseId: "c" });
    await reopened.flush();
  });

  it("also evicts by entry count when the byte budget has room", async () => {
    const path = await pathForTest();
    const limits = { ...options(() => 0), maxBytes: 1_000 };
    const cache = await PersistentLruCache.open(path, limits);
    cache.set("a", { responseId: "a" });
    cache.set("b", { responseId: "b" });
    cache.get("a");
    cache.set("c", { responseId: "c" });
    await cache.flush();
    const restarted = await PersistentLruCache.open(path, limits);
    expect(restarted.get("b")).toBeUndefined();
    expect(restarted.get("a")).toEqual({ responseId: "a" });
    expect(restarted.get("c")).toEqual({ responseId: "c" });
    await restarted.flush();
  });

  it("drops a stale value when its replacement exceeds the byte limit", async () => {
    const path = await pathForTest();
    const cache = await PersistentLruCache.open(
      path,
      options(() => 0),
    );
    cache.set("a", { responseId: "old" });
    cache.set("a", { responseId: "x".repeat(200) });
    expect(cache.get("a")).toBeUndefined();
    await cache.flush();
  });

  it("expires entries across restarts", async () => {
    const path = await pathForTest();
    const cache = await PersistentLruCache.open(
      path,
      options(() => 0),
    );
    cache.set("a", { responseId: "resp_1" });
    await cache.flush();
    const restarted = await PersistentLruCache.open(
      path,
      options(() => 1_000),
    );
    expect(restarted.get("a")).toBeUndefined();
    await restarted.flush();
    expect(JSON.parse(await readFile(path, "utf8")).entries).toEqual([]);
  });

  it("debounces writes and leaves one complete file after the timer fires", async () => {
    const path = await pathForTest();
    const cache = await PersistentLruCache.open(path, {
      ...options(() => 0),
      debounceMs: 20,
    });
    cache.set("a", { responseId: "resp_1" });
    cache.set("a", { responseId: "resp_2" });
    let saved = "";
    for (let attempt = 0; attempt < 50; attempt++) {
      saved = await readFile(path, "utf8").catch(() => "");
      if (saved) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(JSON.parse(saved).entries[0].value).toEqual({ responseId: "resp_2" });
    expect((await readdir(dirname(path))).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    await cache.flush();
  });

  it("warns and starts empty for corrupt or version-mismatched files", async () => {
    const path = await pathForTest();
    const warn = vi.fn();
    await writeFile(path, "{not-json");
    const corrupt = await PersistentLruCache.open(
      path,
      options(() => 0, warn),
    );
    expect(corrupt.get("a")).toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
    await writeFile(path, JSON.stringify({ version: 999, entries: [] }));
    const mismatch = await PersistentLruCache.open(
      path,
      options(() => 0, warn),
    );
    expect(mismatch.get("a")).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(2);
  });
});
