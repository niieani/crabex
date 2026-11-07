import { mkdtemp } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { openProxyConfigStore } from "../config/proxy-config-store.ts";
import { openClientKeyStore } from "./client-keys.ts";
import type { LoginSource } from "./login.ts";
import {
  startSharedLoginService,
  type SharedLoginService,
  type SharedLoginServiceOptions,
} from "./service.ts";

const login: LoginSource = {
  status: async () => ({ state: "ready", path: "auth.json", detail: "" }),
  credential: async () => ({ accessToken: "token", accountId: "account" }),
};

const closeables: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(closeables.splice(0).map((close) => close()));
});

async function service(
  overrides: Partial<SharedLoginServiceOptions> = {},
): Promise<SharedLoginService> {
  const directory = await mkdtemp(join(tmpdir(), "crabex-shared-login-"));
  const started = await startSharedLoginService({
    config: await openProxyConfigStore(join(directory, "config.json")),
    keys: await openClientKeyStore(join(directory, "client-keys.json")),
    login,
    upstreamOrigin: "http://127.0.0.1:1",
    log: () => {},
    ...overrides,
  });
  closeables.push(() => started.close());
  return started;
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  await new Promise((resolve) => server.close(resolve));
  return port;
}

describe("Shared Login service", () => {
  it("runs no listener by default", async () => {
    const status = (await service()).status();
    expect(status).toMatchObject({ enabled: false, running: false, listen: "127.0.0.1:8766" });
    expect(status.origin).toBeUndefined();
  });

  it("starts, moves, and stops the listener without a restart", async () => {
    const shared = await service();
    const first = await freePort();
    await shared.update({ enabled: true, listen: `127.0.0.1:${first}` });
    expect(shared.status()).toMatchObject({ running: true, origin: `http://127.0.0.1:${first}` });
    expect((await fetch(`http://127.0.0.1:${first}/v1/models`)).status).toBe(401);

    const second = await freePort();
    await shared.update({ listen: `127.0.0.1:${second}` });
    expect(shared.status().origin).toBe(`http://127.0.0.1:${second}`);
    await expect(fetch(`http://127.0.0.1:${first}/v1/models`)).rejects.toThrow();

    await shared.update({ enabled: false });
    expect(shared.status().running).toBe(false);
    await expect(fetch(`http://127.0.0.1:${second}/v1/models`)).rejects.toThrow();
  });

  it("reports a port it cannot bind instead of taking the proxy down", async () => {
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
    closeables.push(() => new Promise((resolve) => blocker.close(() => resolve())));
    const { port } = blocker.address() as { port: number };

    const shared = await service();
    await shared.update({ enabled: true, listen: `127.0.0.1:${port}` });
    const status = shared.status();
    expect(status.running).toBe(false);
    expect(status.error).toEqual(expect.any(String));
  });

  it("rejects an invalid address and keeps the running listener", async () => {
    const shared = await service();
    const port = await freePort();
    await shared.update({ enabled: true, listen: `127.0.0.1:${port}` });
    await expect(shared.update({ listen: "nope" })).rejects.toThrow(/listen/);
    expect(shared.status()).toMatchObject({ running: true, listen: `127.0.0.1:${port}` });
  });

  it("honors command-line overrides and locks the matching settings", async () => {
    const port = await freePort();
    const shared = await service({
      enabledOverride: true,
      listenOverride: `127.0.0.1:${port}`,
    });
    expect(shared.status()).toMatchObject({ running: true, enabledOverride: true });
    await expect(shared.update({ enabled: false })).rejects.toThrow(/command line/);
    await expect(shared.update({ listen: "127.0.0.1:1" })).rejects.toThrow(/command line/);
  });

  it("applies concurrent updates without losing either", async () => {
    const shared = await service();
    const port = await freePort();
    await Promise.all([
      shared.update({ enabled: true }),
      shared.update({ listen: `127.0.0.1:${port}` }),
    ]);
    expect(shared.status()).toMatchObject({
      enabled: true,
      listen: `127.0.0.1:${port}`,
      running: true,
    });
  });
});
