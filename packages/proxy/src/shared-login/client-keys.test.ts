import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";

import { openClientKeyStore } from "./client-keys.ts";

async function keysPath(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), "crabex-client-keys-")), "client-keys.json");
}

describe("Client Key store", () => {
  it("shows a secret once, stores only its hash, and survives a restart", async () => {
    const path = await keysPath();
    const store = await openClientKeyStore(path);
    const issued = await store.issue("laptop");

    expect(issued.secret).toMatch(/^crabex_[\w-]{40,}$/);
    expect(store.list()).toEqual([{ id: issued.id, name: "laptop", createdAt: issued.createdAt }]);
    expect(JSON.stringify(store.list())).not.toContain(issued.secret);

    const onDisk = await readFile(path, "utf8");
    expect(onDisk).not.toContain(issued.secret);
    expect((await stat(path)).mode & 0o777).toBe(0o600);

    const reopened = await openClientKeyStore(path);
    expect(reopened.verify(issued.secret)?.name).toBe("laptop");
  });

  it("rejects unknown keys and stops accepting a revoked key at once", async () => {
    const store = await openClientKeyStore(await keysPath());
    const issued = await store.issue("laptop");

    expect(store.verify("crabex_wrong")).toBeUndefined();
    expect(store.verify("")).toBeUndefined();
    expect(store.verify(issued.secret)?.id).toBe(issued.id);

    await store.revoke(issued.id);
    expect(store.verify(issued.secret)).toBeUndefined();
    expect(store.list()).toEqual([]);
  });

  it("records when a key was last used", async () => {
    const store = await openClientKeyStore(await keysPath());
    const issued = await store.issue("laptop");
    store.verify(issued.secret);
    expect(store.list()[0]?.lastUsedAt).toEqual(expect.any(String));
  });

  it("rejects blank and duplicate names and unknown ids", async () => {
    const store = await openClientKeyStore(await keysPath());
    await store.issue("laptop");
    await expect(store.issue("  ")).rejects.toThrow(/name/);
    await expect(store.issue("laptop")).rejects.toThrow(/already exists/);
    await expect(store.revoke("missing")).rejects.toThrow(/unknown/);
  });

  it("fails on a corrupt file rather than starting with no keys", async () => {
    const path = await keysPath();
    await writeFile(path, "{}");
    await expect(openClientKeyStore(path)).rejects.toThrow(/invalid Client Key file/);
  });

  it("keeps every key when several are issued at once", async () => {
    const path = await keysPath();
    const store = await openClientKeyStore(path);
    await Promise.all(["a", "b", "c"].map((name) => store.issue(name)));
    const reopened = await openClientKeyStore(path);
    expect(
      reopened
        .list()
        .map((key) => key.name)
        .toSorted(),
    ).toEqual(["a", "b", "c"]);
  });

  it("tells subscribers when a key is revoked", async () => {
    const store = await openClientKeyStore(await keysPath());
    const issued = await store.issue("laptop");
    const revoked: string[] = [];
    const unsubscribe = store.onRevoke((id) => revoked.push(id));
    await store.revoke(issued.id);
    unsubscribe();
    expect(revoked).toEqual([issued.id]);
  });
});
