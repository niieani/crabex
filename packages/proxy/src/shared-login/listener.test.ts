import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { WebSocketServer } from "ws";

import type { ClientKeyStore, ClientKeySummary } from "./client-keys.ts";
import { startSharedLoginListener, type SharedLoginListener } from "./listener.ts";
import { LoginUnavailableError, type LoginSource } from "./login.ts";

const KEY = "crabex_test";
const ACCESS_TOKEN = "chatgpt-access-token";

const testKey: ClientKeySummary = { id: "1", name: "test", createdAt: "now" };
let keyActive = true;
const revocationListeners = new Set<(id: string) => void>();
const keys: ClientKeyStore = {
  list: () => (keyActive ? [testKey] : []),
  issue: async () => {
    throw new Error("unused");
  },
  revoke: async (id) => {
    keyActive = false;
    for (const listener of revocationListeners) listener(id);
  },
  onRevoke: (listener) => {
    revocationListeners.add(listener);
    return () => revocationListeners.delete(listener);
  },
  verify: (secret) => (keyActive && secret === KEY ? testKey : undefined),
};
const login: LoginSource = {
  status: async () => ({ state: "ready", path: "auth.json", detail: "" }),
  credential: async () => ({ accessToken: ACCESS_TOKEN, accountId: "account-1" }),
};

interface Seen {
  url?: string;
  method?: string;
  headers: IncomingMessage["headers"];
  body: string;
}

let upstream: Server;
let upstreamSockets: WebSocketServer;
let upstreamOrigin: string;
let seen: Seen[];
let listener: SharedLoginListener | undefined;

beforeEach(async () => {
  keyActive = true;
  seen = [];
  upstream = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      seen.push({
        url: request.url,
        method: request.method,
        headers: request.headers,
        body: Buffer.concat(chunks).toString(),
      });
      if (request.url?.includes("redirect")) {
        response.statusCode = 302;
        response.setHeader("location", "https://elsewhere.example/");
        response.end();
        return;
      }
      response.setHeader("content-type", "text/event-stream");
      response.setHeader("set-cookie", "__cf_bm=secret");
      response.end("data: ok\n\n");
    });
  });
  upstreamSockets = new WebSocketServer({ server: upstream });
  upstreamSockets.on("connection", (socket, request) => {
    seen.push({ url: request.url, headers: request.headers, body: "" });
    socket.on("message", (data: Buffer) => socket.send(`echo:${data.toString()}`));
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  upstreamOrigin = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await listener?.close();
  listener = undefined;
  for (const client of upstreamSockets.clients) client.terminate();
  upstreamSockets.close();
  upstream.closeAllConnections();
  await new Promise((resolve) => upstream.close(resolve));
});

async function start(source: LoginSource = login): Promise<string> {
  listener = await startSharedLoginListener({
    host: "127.0.0.1",
    port: 0,
    upstreamOrigin,
    keys,
    login: source,
    log: () => {},
  });
  return listener.origin;
}

const authorized = { authorization: `Bearer ${KEY}` };
const jsonBody = JSON.stringify({ model: "gpt-example", input: "hello" });

function openSocket(
  url: string,
  headers: Record<string, string>,
): Promise<{ socket: WebSocket; messages: string[]; closed: Promise<number> }> {
  return new Promise((resolve, reject) => {
    // Bun's client accepts headers; the standard constructor type does not declare them.
    const socket = new WebSocket(url, { headers } as unknown as string[]);
    const messages: string[] = [];
    socket.onmessage = (event) => messages.push(String(event.data));
    const closed = new Promise<number>((done) => {
      socket.onclose = (event) => done(event.code);
    });
    socket.onopen = () => resolve({ socket, messages, closed });
    socket.onerror = () => reject(new Error("WebSocket failed"));
  });
}

async function until(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200 && !condition(); attempt += 1)
    await new Promise((resolve) => setTimeout(resolve, 5));
  expect(condition()).toBe(true);
}

describe("Shared Login listener over HTTP", () => {
  it("swaps the Client Key for the login and streams the response back", async () => {
    const origin = await start();
    const response = await fetch(`${origin}/v1/responses`, {
      method: "POST",
      headers: {
        ...authorized,
        "content-type": "application/json",
        cookie: "guest=1",
        "chatgpt-account-id": "someone-else",
        "x-codex-window-id": "window-1",
        "session-id": "session-1",
        "x-http-method-override": "DELETE",
        "x-forwarded-for": "203.0.113.9",
        "openai-organization": "org-other",
      },
      body: jsonBody,
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("data: ok\n\n");
    expect(response.headers.get("set-cookie")).toBeNull();

    const [request] = seen;
    expect(request?.url).toBe("/backend-api/codex/responses");
    expect(request?.body).toBe(jsonBody);
    expect(request?.headers.authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(request?.headers["chatgpt-account-id"]).toBe("account-1");
    expect(request?.headers.cookie).toBeUndefined();
    expect(request?.headers["x-codex-window-id"]).toBe("window-1");
    expect(request?.headers["session-id"]).toBe("session-1");
    expect(request?.headers["x-http-method-override"]).toBeUndefined();
    expect(request?.headers["x-forwarded-for"]).toBeUndefined();
    expect(request?.headers["openai-organization"]).toBeUndefined();
  });

  it("forwards the checked body and only declared query parameters", async () => {
    const origin = await start();
    const duplicate = '{"model":"m","tools":[{"type":"mcp"}],"tools":[]}';
    await fetch(`${origin}/v1/responses`, { method: "POST", headers: authorized, body: duplicate });
    await fetch(`${origin}/v1/models?client_version=1.2.3&redirect=1`, { headers: authorized });
    expect(seen[0]?.body).toBe('{"model":"m","tools":[]}');
    expect(seen[1]?.url).toBe("/backend-api/codex/models?client_version=1.2.3");
  });

  it.each([
    ["no key", {}],
    ["wrong key", { authorization: "Bearer crabex_wrong" }],
    ["upstream token", { authorization: `Bearer ${ACCESS_TOKEN}` }],
  ])("answers 401 for %s without reaching upstream", async (_label, headers) => {
    const origin = await start();
    const response = await fetch(`${origin}/v1/responses`, {
      method: "POST",
      headers,
      body: jsonBody,
    });
    expect(response.status).toBe(401);
    expect(seen).toEqual([]);
  });

  it.each([
    ["GET", "/backend-api/ps/mcp"],
    ["POST", "/backend-api/codex/responses"],
    ["POST", "/v1/images/generations"],
    ["GET", "/"],
    ["GET", "/__crabex/api/proxy-config"],
    ["GET", "/setup"],
  ])("answers 403 for %s %s without reaching upstream", async (method, path) => {
    const origin = await start();
    const response = await fetch(`${origin}${path}`, {
      method,
      headers: authorized,
      ...(method === "POST" ? { body: jsonBody } : {}),
    });
    expect(response.status).toBe(403);
    expect(seen).toEqual([]);
  });

  it("does not reveal routes to a caller without a key", async () => {
    const origin = await start();
    expect((await fetch(`${origin}/backend-api/ps/mcp`)).status).toBe(401);
  });

  it("refuses hosted tools and bodies it cannot read", async () => {
    const origin = await start();
    const post = (body: string, headers: Record<string, string> = {}) =>
      fetch(`${origin}/v1/responses`, {
        method: "POST",
        headers: { ...authorized, ...headers },
        body,
      });

    expect((await post(JSON.stringify({ tools: [{ type: "mcp" }] }))).status).toBe(400);
    expect((await post("not json")).status).toBe(400);
    expect((await post(jsonBody, { "content-encoding": "zstd" })).status).toBe(415);
    expect(seen).toEqual([]);
  });

  it("turns an upstream redirect into a 502 without its location", async () => {
    const origin = await start();
    const response = await fetch(`${origin}/v1/models?client_version=redirect`, {
      headers: authorized,
      redirect: "manual",
    });
    expect(response.status).toBe(502);
    expect(response.headers.get("location")).toBeNull();
  });

  it("answers an unexpected failure with a generic 500", async () => {
    const origin = await start({
      status: () => login.status(),
      credential: async () => {
        throw new Error("EACCES: permission denied, open '/home/owner/.codex/auth.json'");
      },
    });
    const response = await fetch(`${origin}/v1/models`, { headers: authorized });
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).not.toContain("/home/owner");
    expect(text.length).toBeLessThan(200);
  });

  it("answers 503 without revealing the owner's paths when the login is unavailable", async () => {
    const origin = await start({
      status: () => login.status(),
      credential: async () => {
        throw new LoginUnavailableError("Expired. Run: CODEX_HOME=/home/owner/.codex codex login");
      },
    });
    const response = await fetch(`${origin}/v1/responses`, {
      method: "POST",
      headers: authorized,
      body: jsonBody,
    });
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("/home/owner");
    expect(seen).toEqual([]);
  });

  it("answers 502 without detail when upstream cannot be reached", async () => {
    listener = await startSharedLoginListener({
      host: "127.0.0.1",
      port: 0,
      upstreamOrigin: "http://127.0.0.1:1",
      keys,
      login,
      log: () => {},
    });
    const response = await fetch(`${listener.origin}/v1/models`, { headers: authorized });
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain(ACCESS_TOKEN);
  });
});

describe("Shared Login listener over WebSocket", () => {
  const url = (origin: string, path = "/v1/responses") => `${origin.replace("http", "ws")}${path}`;

  it("relays frames with the login swapped in", async () => {
    const origin = await start();
    const { socket, messages } = await openSocket(url(origin), {
      ...authorized,
      cookie: "guest=1",
      "session-id": "session-1",
      "openai-beta": "responses_websockets=2026-02-06",
    });
    socket.send(JSON.stringify({ type: "response.create", model: "gpt-example" }));
    await until(() => messages.length === 1);

    expect(messages[0]).toContain("echo:");
    const [request] = seen;
    expect(request?.url).toBe("/backend-api/codex/responses");
    expect(request?.headers.authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(request?.headers["chatgpt-account-id"]).toBe("account-1");
    expect(request?.headers.cookie).toBeUndefined();
    expect(request?.headers["session-id"]).toBe("session-1");
    expect(request?.headers["openai-beta"]).toBe("responses_websockets=2026-02-06");
    socket.close();
  });

  it("refuses a handshake without a key or on another path", async () => {
    const origin = await start();
    const handshake = (path: string, headers: Record<string, string>) =>
      fetch(`${origin}${path}`, { headers: { ...headers, upgrade: "websocket" } });
    expect((await handshake("/v1/responses", {})).status).toBe(401);
    expect((await handshake("/v1/other", authorized)).status).toBe(403);
    expect(seen).toEqual([]);
  });

  it("closes the connection on a hosted tool without forwarding the frame", async () => {
    const origin = await start();
    const { socket, messages, closed } = await openSocket(url(origin), authorized);
    socket.send(JSON.stringify({ type: "response.create", tools: [{ type: "mcp" }] }));
    expect(await closed).toBe(1008);
    expect(messages).toEqual([]);
    await until(() => upstreamSockets.clients.size === 0);
  });

  it("answers 502 to the handshake when upstream refuses the WebSocket", async () => {
    listener = await startSharedLoginListener({
      host: "127.0.0.1",
      port: 0,
      upstreamOrigin: "http://127.0.0.1:1",
      keys,
      login,
      log: () => {},
    });
    const handshake = await fetch(`${listener.origin}/v1/responses`, {
      headers: {
        ...authorized,
        upgrade: "websocket",
        connection: "Upgrade",
        "sec-websocket-version": "13",
        "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
      },
    });
    expect(handshake.status).toBe(502);
  });

  it("closes an open WebSocket as soon as its key is revoked", async () => {
    const origin = await start();
    const { socket, messages, closed } = await openSocket(url(origin), authorized);
    socket.send(JSON.stringify({ type: "response.create", model: "first" }));
    await until(() => messages.length === 1);
    await keys.revoke("1");
    expect(await closed).toBe(1008);
    expect(messages).toHaveLength(1);
  });

  it("refuses frames other than response.create", async () => {
    const origin = await start();
    const { socket, closed } = await openSocket(url(origin), authorized);
    socket.send(JSON.stringify({ type: "session.update", tools: [{ type: "mcp" }] }));
    expect(await closed).toBe(1008);
  });

  it("closes the connection on a binary frame", async () => {
    const origin = await start();
    const { socket, closed } = await openSocket(url(origin), authorized);
    socket.send(new Uint8Array([1, 2, 3]));
    expect(await closed).toBe(1003);
  });
});
