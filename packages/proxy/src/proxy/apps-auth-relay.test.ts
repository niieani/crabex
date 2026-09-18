import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { CaptureEvent } from "../recording/capture.ts";
import { startReverseProxy } from "./server.ts";
import { AppsAuthRelay } from "./apps-auth-relay.ts";
import { openProxyConfigStore, type ProxyConfigStore } from "../config/proxy-config-store.ts";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const closeables: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const close of closeables.splice(0).reverse()) await close();
});

async function fixture(enabled?: boolean, proxyConfigSource?: ProxyConfigStore) {
  const seen: Array<{ path: string; authorization: string | null; account: string | null }> = [];
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      seen.push({
        path: new URL(request.url).pathname,
        authorization: request.headers.get("authorization"),
        account: request.headers.get("chatgpt-account-id"),
      });
      return Response.json({ ok: true });
    },
  });
  closeables.push(() => upstream.stop(true));
  const events: CaptureEvent[] = [];
  const proxy = await startReverseProxy({
    port: 0,
    upstreamOrigin: upstream.url.origin,
    appsAuthRelay: enabled,
    proxyConfigSource,
    captureSink: {
      async record(event) {
        events.push(event);
      },
    },
    configBundleSource: { get: () => ({ enabled: true, bundle: {}, version: 1 }) },
  });
  closeables.push(() => proxy.close());
  async function seed(
    token = "first-token",
    account = "account-a",
    path = "/backend-api/wham/config/bundle",
  ) {
    const response = await fetch(proxy.origin + path, {
      headers: { authorization: `Bearer ${token}`, "chatgpt-account-id": account },
    });
    await response.text();
  }
  async function mcp(headers?: Record<string, string>, path = "/backend-api/ps/mcp") {
    const response = await fetch(proxy.origin + path, {
      method: "POST",
      headers,
      body: '{"jsonrpc":"2.0","id":1,"method":"initialize"}',
    });
    await response.text();
    return response.status;
  }
  return { seen, events, seed, mcp, proxy };
}

describe("Apps authentication relay", () => {
  it("keeps a slow directory request open beyond Bun's default HTTP idle timeout", async () => {
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      idleTimeout: 0,
      async fetch() {
        await Bun.sleep(22_000);
        return Response.json({ apps: [] });
      },
    });
    closeables.push(() => upstream.stop(true));
    const proxy = await startReverseProxy({
      port: 0,
      upstreamOrigin: upstream.url.origin,
      captureSink: { async record() {} },
    });
    closeables.push(() => proxy.close());
    const response = await fetch(proxy.origin + "/backend-api/connectors/directory/list", {
      signal: AbortSignal.timeout(28_000),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ apps: [] });
  }, 30_000);
  it("uses credentials even when the config bundle is answered locally, and follows refreshes", async () => {
    const f = await fixture();
    await f.seed();
    expect(await f.mcp()).toBe(200);
    expect(f.seen.at(-1)).toMatchObject({
      authorization: "Bearer first-token",
      account: "account-a",
    });
    await f.seed("refreshed-token");
    await f.mcp();
    expect(f.seen.at(-1)).toMatchObject({
      authorization: "Bearer refreshed-token",
      account: "account-a",
    });
    expect(JSON.stringify(f.events)).not.toMatch(/first-token|refreshed-token|account-a/);
  });

  it("waits for the first authenticated request when Apps arrives first", async () => {
    const f = await fixture();
    const pending = f.mcp();
    await new Promise((resolve) => setTimeout(resolve, 30));
    await f.seed();
    expect(await pending).toBe(200);
    expect(f.seen.at(-1)?.authorization).toBe("Bearer first-token");
  });

  it("preserves explicit Apps credentials and never adds credentials to other paths", async () => {
    const f = await fixture();
    await f.seed();
    await f.mcp({ authorization: "Bearer explicit-token" });
    expect(f.seen.at(-1)).toMatchObject({ authorization: "Bearer explicit-token", account: null });
    await f.mcp(undefined, "/backend-api/other");
    expect(f.seen.at(-1)).toMatchObject({ authorization: null, account: null });
    await f.mcp({ "chatgpt-account-id": "account-b" });
    expect(f.seen.at(-1)?.path).toBe("/backend-api/other");
  });

  it("stops relaying after observing a second account instead of mixing credentials", async () => {
    const f = await fixture();
    await f.seed();
    await f.seed("second-token", "account-b");
    expect(await f.mcp()).toBe(503);
    expect(f.seen).toHaveLength(0);
  });

  it("honors an explicit relay opt-out", async () => {
    const f = await fixture(false);
    await f.seed();
    await f.mcp();
    expect(f.seen.at(-1)?.authorization).toBeNull();
  });

  it("applies persisted config changes immediately and clears credentials when disabled", async () => {
    const config = await openProxyConfigStore(
      join(await mkdtemp(join(tmpdir(), "act-relay-config-")), "config.json"),
    );
    const f = await fixture(undefined, config);
    await f.seed();
    await f.mcp();
    expect(f.seen.at(-1)?.authorization).toBe("Bearer first-token");
    await config.replace({ version: 1, appsAuthRelay: false });
    await f.mcp();
    expect(f.seen.at(-1)?.authorization).toBeNull();
    await config.replace({ version: 1, appsAuthRelay: true });
    const count = f.seen.length;
    const pending = f.mcp();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(f.seen).toHaveLength(count);
    await f.seed("fresh-login");
    await pending;
    expect(f.seen.at(-1)?.authorization).toBe("Bearer fresh-login");
  });

  it("times out without credentials and does not learn credentials from local API requests", async () => {
    vi.useFakeTimers();
    const relay = new AppsAuthRelay();
    relay.observe(
      new Request("http://localhost/api/settings", {
        headers: { authorization: "Bearer local-token", "chatgpt-account-id": "account-a" },
      }),
    );
    const pending = relay.authenticate(new Request("http://localhost/backend-api/ps/mcp"));
    await vi.advanceTimersByTimeAsync(5_000);
    const response = await pending;
    expect(response).toBeInstanceOf(Response);
    expect((response as Response).status).toBe(503);
    expect(await (response as Response).text()).toContain(
      "waiting for an authenticated Codex request",
    );
    relay.close();
  });

  it("refuses to expose cached credentials on a non-loopback listener", async () => {
    await expect(
      startReverseProxy({
        host: "0.0.0.0",
        port: 0,
        upstreamOrigin: "https://chatgpt.com",
        appsAuthRelay: true,
        captureSink: { async record() {} },
      }),
    ).rejects.toThrow("loopback listener");
  });
});
