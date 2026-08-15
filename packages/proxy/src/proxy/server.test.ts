import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vite-plus/test";
import WebSocket, { type RawData, WebSocketServer } from "ws";

import type { CaptureEvent, CaptureSink } from "../recording/capture.ts";
import type { Transformation } from "../context/transformation.ts";
import { startReverseProxy, type RunningProxy } from "./server.ts";

class MemoryCaptureSink implements CaptureSink {
  readonly events: CaptureEvent[] = [];

  async record(event: CaptureEvent): Promise<void> {
    this.events.push(event);
  }
}

const closeables: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closeables.splice(0).map((close) => close()));
});

describe("subscription reverse proxy", () => {
  it("forwards an HTTP Responses request with OAuth headers and records only its body", async () => {
    const requestBody = '{"model":"gpt-5.6","input":"hello"}';
    const upstream = await startHttpServer(async (request, response) => {
      expect(request.url).toBe("/backend-api/codex/responses?trace=1");
      expect(request.headers.authorization).toBe("Bearer oauth-secret");
      expect(request.headers["chatgpt-account-id"]).toBe("workspace-123");
      expect(await readBody(request)).toEqual(Buffer.from(requestBody));

      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write('data: {"type":"response.output_text.delta"}\n\n');
      response.end("data: [DONE]\n\n");
    });
    const captures = new MemoryCaptureSink();
    const proxy = await startProxy(upstream.origin, captures);

    const response = await fetch(`${proxy.origin}/backend-api/codex/responses?trace=1`, {
      method: "POST",
      headers: {
        authorization: "Bearer oauth-secret",
        "chatgpt-account-id": "workspace-123",
        "content-type": "application/json",
      },
      body: requestBody,
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(
      'data: {"type":"response.output_text.delta"}\n\ndata: [DONE]\n\n',
    );
    expect(captures.events).toMatchObject([
      {
        transport: "http",
        direction: "client_to_upstream",
        payload: requestBody,
      },
    ]);
    expect(JSON.stringify(captures.events)).not.toContain("oauth-secret");
  });

  it("forwards and records WebSocket frames in both directions", async () => {
    const upstream = await startWebSocketServer((socket, request) => {
      expect(request.url).toBe("/backend-api/codex/responses");
      expect(request.headers.authorization).toBe("Bearer oauth-secret");
      expect(request.headers["chatgpt-account-id"]).toBe("workspace-123");

      socket.on("message", (message, isBinary) => {
        expect(isBinary).toBe(false);
        expect(rawDataText(message)).toBe('{"type":"response.create","generate":false}');
        socket.send('{"type":"response.created","response":{"id":"resp_1"}}');
      });
    });
    const captures = new MemoryCaptureSink();
    const proxy = await startProxy(upstream.origin, captures);
    const client = new WebSocket(
      proxy.origin.replace("http://", "ws://") + "/backend-api/codex/responses",
      {
        headers: {
          authorization: "Bearer oauth-secret",
          "chatgpt-account-id": "workspace-123",
        },
      },
    );
    closeables.push(async () => client.close());

    await opened(client);
    client.send('{"type":"response.create","generate":false}');
    expect(await nextMessage(client)).toBe(
      '{"type":"response.created","response":{"id":"resp_1"}}',
    );
    await eventually(() => expect(captures.events).toHaveLength(2));
    expect(captures.events).toMatchObject([
      {
        transport: "websocket",
        direction: "client_to_upstream",
        payload: '{"type":"response.create","generate":false}',
      },
      {
        transport: "websocket",
        direction: "upstream_to_client",
        payload: '{"type":"response.created","response":{"id":"resp_1"}}',
      },
    ]);
  });

  it("rewrites a WebSocket response.create and records original and effective payloads", async () => {
    const upstream = await startWebSocketServer((socket) => {
      socket.on("message", (message) => {
        expect(JSON.parse(rawDataText(message))).toMatchObject({
          input: [{ content: [{ text: "Reply with exactly: transformed-smoke" }] }],
        });
        socket.send('{"type":"response.completed","response":{"id":"resp_1"}}');
      });
    });
    const captures = new MemoryCaptureSink();
    const transformations: Transformation[] = [
      {
        id: "smoke",
        name: "Smoke rewrite",
        enabled: true,
        scope: { harnesses: ["tui"] },
        target: { field: "message_text" },
        operation: {
          type: "replace",
          find: "Reply with exactly: original-smoke",
          replacement: "Reply with exactly: transformed-smoke",
        },
      },
    ];
    const proxy = await startProxy(upstream.origin, captures, transformations);
    const client = new WebSocket(
      proxy.origin.replace("http://", "ws://") + "/backend-api/codex/responses",
      {
        headers: {
          originator: "codex-tui",
          "user-agent": "codex-tui/0.146.0 (Mac OS 26.5.0; arm64)",
        },
      },
    );
    closeables.push(async () => client.close());
    await opened(client);
    client.send(
      JSON.stringify({
        type: "response.create",
        model: "gpt-5.6-luna",
        input: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Reply with exactly: original-smoke" }],
          },
        ],
      }),
    );
    await nextMessage(client);
    await eventually(() => expect(captures.events).toHaveLength(2));

    expect(captures.events[0]).toMatchObject({
      harness: { kind: "tui", version: "0.146.0" },
      transformationExecutions: [
        { transformationId: "smoke", status: "hit", matchCount: 1 },
      ],
    });
    expect(captures.events[0]?.payload).toContain("original-smoke");
    expect(captures.events[0]?.effectivePayload).toContain("transformed-smoke");
  });

  it("fails closed before an HTTP request reaches upstream when capture fails", async () => {
    let upstreamRequests = 0;
    const upstream = await startHttpServer((_request, response) => {
      upstreamRequests += 1;
      response.end();
    });
    const proxy = await startProxy(upstream.origin, {
      record: async () => {
        throw new Error("disk full");
      },
    });

    const response = await fetch(`${proxy.origin}/backend-api/codex/responses`, {
      method: "POST",
      body: "{}",
    });

    expect(response.status).toBe(500);
    expect(await response.text()).toContain("capture failed");
    expect(upstreamRequests).toBe(0);
  });

  it("retains only Cloudflare infrastructure cookies for upstream requests", async () => {
    const seenCookies: Array<string | undefined> = [];
    const upstream = await startHttpServer((request, response) => {
      seenCookies.push(request.headers.cookie);
      response.setHeader("set-cookie", [
        "__cf_bm=affinity; Path=/; Secure; HttpOnly",
        "session=must-not-be-retained; Path=/; Secure",
      ]);
      response.end("ok");
    });
    const proxy = await startProxy(upstream.origin, new MemoryCaptureSink());

    await fetch(`${proxy.origin}/backend-api/codex/responses`, {
      method: "POST",
      body: "first",
    });
    await fetch(`${proxy.origin}/backend-api/codex/responses`, {
      method: "POST",
      body: "second",
    });

    expect(seenCookies).toEqual([undefined, "__cf_bm=affinity"]);
  });
});

async function startProxy(
  upstreamOrigin: string,
  captureSink: CaptureSink,
  transformations: Transformation[] = [],
): Promise<RunningProxy> {
  const proxy = await startReverseProxy({
    host: "127.0.0.1",
    port: 0,
    upstreamOrigin,
    captureSink,
    transformationSource: { get: () => transformations },
  });
  closeables.push(() => proxy.close());
  return proxy;
}

async function startHttpServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<{ origin: string }> {
  const server = createServer(handler);
  await listen(server);
  closeables.push(() => closeServer(server));
  return { origin: serverOrigin(server) };
}

async function startWebSocketServer(
  onConnection: (socket: WebSocket, request: IncomingMessage) => void,
): Promise<{ origin: string }> {
  const server = createServer();
  const webSocketServer = new WebSocketServer({ server });
  webSocketServer.on("connection", onConnection);
  await listen(server);
  closeables.push(
    () =>
      new Promise<void>((resolve) => {
        webSocketServer.close(() => resolve());
      }),
  );
  closeables.push(() => closeServer(server));
  return { origin: serverOrigin(server) };
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function serverOrigin(server: Server): string {
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function opened(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
}

function nextMessage(socket: WebSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    socket.once("message", (message) => resolve(rawDataText(message)));
    socket.once("error", reject);
  });
}

function rawDataText(message: RawData): string {
  if (Array.isArray(message)) return Buffer.concat(message).toString();
  if (message instanceof ArrayBuffer) return Buffer.from(message).toString();
  return Buffer.from(message.buffer, message.byteOffset, message.byteLength).toString();
}

async function eventually(assertion: () => void): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      assertion();
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  assertion();
}
