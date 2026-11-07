import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { openProxyConfigStore } from "../config/proxy-config-store.ts";
import { createSharedLoginApi } from "./api.ts";
import { openClientKeyStore } from "./client-keys.ts";
import { startSharedLoginService, type SharedLoginService } from "./service.ts";

const SECRET_TOKEN = "chatgpt-access-token";
const BASE = "http://127.0.0.1:8765/__crabex/api/shared-login";

const closeables: SharedLoginService[] = [];
afterEach(async () => {
  await Promise.all(closeables.splice(0).map((service) => service.close()));
});

async function api() {
  const directory = await mkdtemp(join(tmpdir(), "crabex-shared-login-api-"));
  const service = await startSharedLoginService({
    config: await openProxyConfigStore(join(directory, "config.json")),
    keys: await openClientKeyStore(join(directory, "client-keys.json")),
    login: {
      status: async () => ({ state: "ready", path: "auth.json", detail: "ok" }),
      credential: async () => ({ accessToken: SECRET_TOKEN, accountId: "account" }),
    },
    refresher: { check: async () => {}, state: () => ({}) },
    upstreamOrigin: "http://127.0.0.1:1",
    log: () => {},
  });
  closeables.push(service);
  const handle = createSharedLoginApi(service);
  return (request: Request, peer = "127.0.0.1") => handle(request, peer);
}

const write = (method: string, body: unknown, path = "") =>
  new Request(`${BASE}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("Shared Login API", () => {
  it("ignores other paths", async () => {
    const handle = await api();
    expect(await handle(new Request("http://127.0.0.1:8765/__crabex/api/stats"))).toBeUndefined();
  });

  it("reports state without any secret", async () => {
    const handle = await api();
    const response = await handle(new Request(BASE));
    const text = await response?.text();
    expect(JSON.parse(text ?? "{}")).toMatchObject({
      enabled: false,
      running: false,
      keys: [],
      login: { state: "ready" },
    });
    expect(text).not.toContain(SECRET_TOKEN);
  });

  it("issues a key once, lists it without the secret, and revokes it", async () => {
    const handle = await api();
    const issued = (await (await handle(write("POST", { name: "laptop" }, "/keys")))?.json()) as {
      key: { id: string; secret: string };
    };
    expect(issued.key.secret).toMatch(/^crabex_/);

    const listed = await (await handle(new Request(BASE)))?.text();
    expect(listed).toContain("laptop");
    expect(listed).not.toContain(issued.key.secret);

    const removed = await handle(
      new Request(`${BASE}/keys/${issued.key.id}`, { method: "DELETE" }),
    );
    expect(removed?.status).toBe(200);
    expect(((await removed!.json()) as { keys: unknown[] }).keys).toEqual([]);
  });

  it("reports bad input as an error", async () => {
    const handle = await api();
    expect((await handle(write("POST", { name: "" }, "/keys")))?.status).toBe(400);
    expect((await handle(write("POST", {}, "/keys")))?.status).toBe(400);
    expect((await handle(write("PUT", { listen: "nope" })))?.status).toBe(400);
  });

  it("refuses writes a browser page could send", async () => {
    const handle = await api();
    const simple = new Request(`${BASE}/keys`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({ name: "x" }),
    });
    expect((await handle(simple))?.status).toBe(415);

    const crossOrigin = new Request(`${BASE}/keys`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.example" },
      body: JSON.stringify({ name: "x" }),
    });
    expect((await handle(crossOrigin))?.status).toBe(403);

    const remove = new Request(`${BASE}/keys/any`, {
      method: "DELETE",
      headers: { origin: "https://evil.example" },
    });
    expect((await handle(remove))?.status).toBe(403);
  });

  it("refuses a rebound hostname, even for reads", async () => {
    const handle = await api();
    const rebound = new Request("http://evil.example:8765/__crabex/api/shared-login");
    expect((await handle(rebound))?.status).toBe(403);
  });

  it("refuses every request that does not come from this machine", async () => {
    const handle = await api();
    expect((await handle(new Request(BASE), "192.0.2.7"))?.status).toBe(403);
    expect((await handle(write("POST", { name: "x" }, "/keys"), "192.0.2.7"))?.status).toBe(403);
    expect((await handle(new Request(BASE), "::1"))?.status).toBe(200);
  });

  it("changes one setting without resetting the other", async () => {
    const handle = await api();
    await handle(write("PUT", { listen: "127.0.0.1:0" }));
    const enabled = (await (await handle(write("PUT", { enabled: true })))?.json()) as {
      enabled: boolean;
      listen: string;
      running: boolean;
    };
    expect(enabled).toMatchObject({ enabled: true, listen: "127.0.0.1:0", running: true });
    const moved = (await (await handle(write("PUT", { listen: "127.0.0.1:0" })))?.json()) as {
      enabled: boolean;
    };
    expect(moved.enabled).toBe(true);
  });

  it("turns login renewal off and on", async () => {
    const handle = await api();
    expect(await (await handle(write("PUT", { refresh: false })))?.json()).toMatchObject({
      refresh: false,
      renewal: {},
    });
    expect(await (await handle(new Request(BASE)))?.json()).toMatchObject({ refresh: false });
  });

  it("rejects settings of the wrong type", async () => {
    const handle = await api();
    expect((await handle(write("PUT", { enabled: "yes" })))?.status).toBe(400);
    expect((await handle(write("PUT", { refresh: "no" })))?.status).toBe(400);
    expect((await handle(write("PUT", [])))?.status).toBe(400);
  });
});
