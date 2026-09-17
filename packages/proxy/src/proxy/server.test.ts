import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vite-plus/test";
import WebSocket, { type RawData, WebSocketServer } from "ws";

import type { CaptureEvent, CaptureSink } from "../recording/capture.ts";
import type { ConfigBundleOverride } from "../config/config-bundle-store.ts";
import type {
  UpstreamCacheKind,
  UpstreamCacheState,
  UpstreamCacheStore,
} from "../config/upstream-cache.ts";
import type { Transformation } from "../context/transformation.ts";
import type { ModelAdjustment, ModelRoute } from "../routing/model-routes.ts";
import { modelRouteFromConfig } from "../routing/model-routes.ts";
import type { ModelDefinition } from "../routing/model-list.ts";
import { sanitizeCloseCode, startReverseProxy, type RunningProxy } from "./server.ts";

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
        origin: {
          kind: "chatgpt-http",
          url: expect.stringContaining("/backend-api/codex/responses"),
        },
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
        origin: { kind: "chatgpt-websocket", url: expect.stringMatching(/^ws:\/\//) },
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
      transformationExecutions: [{ transformationId: "smoke", status: "hit", matchCount: 1 }],
    });
    expect(captures.events[0]).toMatchObject({
      payload: expect.stringContaining("original-smoke"),
      effectivePayload: expect.stringContaining("transformed-smoke"),
    });
  });

  it("switches to metadata-only capture after the first real user message", async () => {
    let requestCount = 0;
    const upstream = await startWebSocketServer((socket) => {
      socket.on("message", (message) => {
        requestCount += 1;
        const payload = JSON.parse(rawDataText(message)) as Record<string, unknown>;
        if (requestCount === 3) {
          expect(JSON.stringify(payload)).toContain("later-effective");
          expect(JSON.stringify(payload)).not.toContain("later-original");
        }
        socket.send(
          JSON.stringify({
            type: "response.completed",
            response: { id: `resp_${requestCount}`, usage: { input_tokens: requestCount } },
          }),
        );
      });
    });
    const captures = new MemoryCaptureSink();
    const transformations: Transformation[] = [
      {
        id: "later-rewrite",
        name: "Later rewrite",
        enabled: true,
        scope: {},
        target: { field: "message_text" },
        operation: {
          type: "replace",
          find: "later-original",
          replacement: "later-effective",
        },
      },
    ];
    const proxy = await startProxy(upstream.origin, captures, transformations);
    const client = new WebSocket(
      proxy.origin.replace("http://", "ws://") + "/backend-api/codex/responses",
    );
    closeables.push(async () => client.close());
    await opened(client);

    client.send(
      JSON.stringify({
        type: "response.create",
        generate: false,
        input: [message("developer", "prewarm")],
      }),
    );
    await nextMessage(client);
    client.send(
      JSON.stringify({
        type: "response.create",
        input: [message("developer", "initial context"), message("user", "first-real-user")],
      }),
    );
    await nextMessage(client);
    client.send(
      JSON.stringify({
        type: "response.create",
        previous_response_id: "resp_2",
        input: [
          message("developer", "later developer injection"),
          message("user", "<environment_context>\nlater harness context"),
          message("user", "later-original"),
        ],
      }),
    );
    await nextMessage(client);
    await eventually(() => expect(captures.events).toHaveLength(6));

    const clientEvents = captures.events.filter(
      (event) => event.direction === "client_to_upstream",
    );
    expect(clientEvents[0]).toMatchObject({ payloadMode: "full" });
    expect(clientEvents[1]).toMatchObject({ payloadMode: "full" });
    expect(clientEvents[2]).toMatchObject({
      payloadMode: "metadata",
      requestSummary: {
        type: "response.create",
        messages: [
          { role: "developer", characters: 25 },
          { role: "user", classificationId: "segment:environment" },
          { role: "user", characters: 14 },
        ],
      },
      transformationChanged: true,
      transformationExecutions: [
        { transformationId: "later-rewrite", status: "hit", matchCount: 1 },
      ],
    });
    expect(clientEvents[2]).not.toHaveProperty("payload");
    expect(JSON.stringify(clientEvents[2])).not.toContain("later-original");

    const responseEvents = captures.events.filter(
      (event) => event.direction === "upstream_to_client",
    );
    expect(responseEvents[2]).toMatchObject({
      payloadMode: "metadata",
      responseSummary: { type: "response.completed", id: "resp_3" },
    });
    expect(responseEvents[2]).not.toHaveProperty("payload");
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

describe("model routing and config bundle override", () => {
  it("serves an enabled config bundle override without hitting upstream", async () => {
    let upstreamRequests = 0;
    const upstream = await startHttpServer((_request, response) => {
      upstreamRequests += 1;
      response.end("upstream");
    });
    const captures = new MemoryCaptureSink();
    const proxy = await startRoutingProxy(upstream.origin, captures, {
      bundleOverride: { version: 1, enabled: true, bundle: { requirements_toml: null } },
    });

    const response = await fetch(`${proxy.origin}/backend-api/wham/config/bundle`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ requirements_toml: null });
    expect(upstreamRequests).toBe(0);
    expect(captures.events).toMatchObject([
      { transport: "http", routing: { action: "bundle-override" } },
    ]);
  });

  it("forwards config bundle requests when the override is disabled", async () => {
    const upstream = await startHttpServer((_request, response) => {
      response.end("upstream-bundle");
    });
    const proxy = await startRoutingProxy(upstream.origin, new MemoryCaptureSink(), {
      bundleOverride: { version: 1, enabled: false, bundle: null },
    });

    const response = await fetch(`${proxy.origin}/backend-api/wham/config/bundle`);

    expect(await response.text()).toBe("upstream-bundle");
  });

  it("routes a Responses request to the route upstream with swapped credentials", async () => {
    process.env.ACT_TEST_ROUTE_KEY = "local-api-key";
    try {
      const chatgpt = await startHttpServer((_request, response) => {
        response.end("chatgpt");
      });
      const routed = await startHttpServer(async (request, response) => {
        expect(request.url).toBe("/v1/responses?trace=1");
        expect(request.headers.authorization).toBe("Bearer local-api-key");
        expect(request.headers["chatgpt-account-id"]).toBeUndefined();
        expect(request.headers.cookie).toBeUndefined();
        const body = await readBody(request);
        expect(JSON.parse(body.toString())).toMatchObject({ model: "moonshot-kimi-k3" });
        response.end("routed");
      });
      const captures = new MemoryCaptureSink();
      const proxy = await startRoutingProxy(chatgpt.origin, captures, {
        routes: [testRoute(routed.origin)],
      });

      const response = await fetch(`${proxy.origin}/backend-api/codex/responses?trace=1`, {
        method: "POST",
        headers: {
          authorization: "Bearer oauth-secret",
          "chatgpt-account-id": "workspace-123",
          "content-type": "application/json",
          cookie: "session=secret",
        },
        body: JSON.stringify({ model: "kimi-k3", input: "hello" }),
      });

      expect(response.status).toBe(200);
      expect(await response.text()).toBe("routed");
      expect(captures.events[0]).toMatchObject({
        routing: {
          action: "routed",
          routeSlugs: ["kimi-k3"],
          upstream: routed.origin,
          requestedModel: "kimi-k3",
          upstreamModel: "moonshot-kimi-k3",
        },
        origin: {
          kind: "gateway-http",
          url: `${routed.origin}/v1/responses?trace=1`,
        },
      });
    } finally {
      delete process.env.ACT_TEST_ROUTE_KEY;
    }
  });

  it("decompresses a zstd Responses body before routing it to the gateway", async () => {
    process.env.ACT_TEST_ROUTE_KEY = "local-api-key";
    try {
      let chatgptHits = 0;
      const chatgpt = await startHttpServer((_request, response) => {
        chatgptHits += 1;
        response.end("chatgpt");
      });
      const routed = await startHttpServer(async (request, response) => {
        expect(request.headers["content-encoding"]).toBeUndefined();
        const body = await readBody(request);
        expect(JSON.parse(body.toString())).toMatchObject({
          model: "moonshot-kimi-k3",
          input: "hello",
        });
        response.end("routed");
      });
      const captures = new MemoryCaptureSink();
      const proxy = await startRoutingProxy(chatgpt.origin, captures, {
        routes: [testRoute(routed.origin)],
      });
      const payload = JSON.stringify({ model: "kimi-k3", input: "hello" });
      const compressed = Buffer.from(await Bun.zstdCompress(payload));

      const response = await fetch(`${proxy.origin}/backend-api/codex/responses`, {
        method: "POST",
        headers: {
          authorization: "Bearer oauth-secret",
          "content-type": "application/json",
          "content-encoding": "zstd",
        },
        body: compressed,
      });

      expect(response.status).toBe(200);
      expect(await response.text()).toBe("routed");
      expect(chatgptHits).toBe(0);
      expect(captures.events[0]).toMatchObject({
        routing: {
          action: "routed",
          requestedModel: "kimi-k3",
          upstreamModel: "moonshot-kimi-k3",
        },
        origin: { kind: "gateway-http" },
      });
    } finally {
      delete process.env.ACT_TEST_ROUTE_KEY;
    }
  });

  it("keeps unmatched models on the default upstream", async () => {
    const chatgpt = await startHttpServer((request, response) => {
      expect(request.headers.authorization).toBe("Bearer oauth-secret");
      response.end("chatgpt");
    });
    const proxy = await startRoutingProxy(chatgpt.origin, new MemoryCaptureSink(), {
      routes: [testRoute("http://127.0.0.1:1")],
    });

    const response = await fetch(`${proxy.origin}/backend-api/codex/responses`, {
      method: "POST",
      headers: { authorization: "Bearer oauth-secret", "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-5.6", input: "hello" }),
    });

    expect(await response.text()).toBe("chatgpt");
  });

  it("fails a routed request with 502 when the route credential env is unset", async () => {
    delete process.env.ACT_TEST_ROUTE_KEY;
    const chatgpt = await startHttpServer((_request, response) => {
      response.end("chatgpt");
    });
    const proxy = await startRoutingProxy(chatgpt.origin, new MemoryCaptureSink(), {
      routes: [testRoute("http://127.0.0.1:1")],
    });

    const response = await fetch(`${proxy.origin}/backend-api/codex/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "kimi-k3", input: "hello" }),
    });

    expect(response.status).toBe(502);
    expect(await response.text()).toContain("ACT_TEST_ROUTE_KEY");
  });

  it("prepends routed models to the upstream model list", async () => {
    const chatgpt = await startHttpServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          models: [
            {
              slug: "gpt-5.6-terra",
              context_window: 272000,
              display_name: "GPT-5.6 Terra",
              upgrade: { model: "gpt-5.7" },
            },
          ],
        }),
      );
    });
    const captures = new MemoryCaptureSink();
    const proxy = await startRoutingProxy(chatgpt.origin, captures, {
      routes: [testRoute("http://127.0.0.1:1")],
    });

    const response = await fetch(`${proxy.origin}/backend-api/codex/models`);

    expect(response.status).toBe(200);
    const body = (await response.json()) as { models: Array<Record<string, unknown>> };
    expect(body.models.map((model) => model.slug)).toEqual(["kimi-k3", "gpt-5.6-terra"]);
    expect(body.models[0]).toMatchObject({
      slug: "kimi-k3",
      display_name: "Kimi K3",
      context_window: 272000,
    });
    expect(body.models[0]).not.toHaveProperty("upgrade");
    expect(captures.events[0]).toMatchObject({
      routing: { action: "models-advertised", routeSlugs: ["kimi-k3"] },
    });
  });

  it("advertises a route templated on a fixture-only model", async () => {
    const chatgpt = await startHttpServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ models: [{ slug: "gpt-5.6-terra" }] }));
    });
    const astraRoute: ModelRoute = {
      ...testRoute("http://127.0.0.1:1"),
      model: {
        description: "Astra via another upstream",
        displayName: "My Astra",
        overrides: {},
        priority: 1,
        slug: "my-astra",
        templateSlug: "gpt-6-astra",
      },
    };
    const proxy = await startRoutingProxy(chatgpt.origin, new MemoryCaptureSink(), {
      routes: [astraRoute],
    });

    const response = await fetch(`${proxy.origin}/backend-api/codex/models`);

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      models: Array<{ slug: string; model_messages?: Record<string, unknown> }>;
    };
    expect(body.models.map((model) => model.slug)).toEqual(["my-astra", "gpt-5.6-terra"]);
    // Cloned from the baked-in gpt-6-astra fixture, including its model_messages.
    expect(body.models[0]?.model_messages).toHaveProperty("persistent_instructions");
    expect(body.models[0]?.model_messages).toHaveProperty("guardian_v2");
  });

  it("serves the fixture version of a pinned upstream model", async () => {
    const chatgpt = await startHttpServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          models: [{ slug: "gpt-5.6-terra", display_name: "GPT-5.6 Terra (upstream)" }],
        }),
      );
    });
    const fixtureModels: ModelDefinition[] = [
      { slug: "gpt-5.6-terra", display_name: "GPT-5.6 Terra (fixture)" },
    ];
    const pinned = await startRoutingProxy(chatgpt.origin, new MemoryCaptureSink(), {
      fixtureModels,
      fixturePins: ["gpt-5.6-terra"],
    });

    const pinnedResponse = await fetch(`${pinned.origin}/backend-api/codex/models`);
    expect(pinnedResponse.status).toBe(200);
    const pinnedBody = (await pinnedResponse.json()) as {
      models: Array<{ display_name: string }>;
    };
    expect(pinnedBody.models[0]?.display_name).toBe("GPT-5.6 Terra (fixture)");

    const unpinned = await startRoutingProxy(chatgpt.origin, new MemoryCaptureSink(), {
      fixtureModels,
    });
    const unpinnedResponse = await fetch(`${unpinned.origin}/backend-api/codex/models`);
    const unpinnedBody = (await unpinnedResponse.json()) as {
      models: Array<{ display_name: string }>;
    };
    expect(unpinnedBody.models[0]?.display_name).toBe("GPT-5.6 Terra (upstream)");
  });

  it("retries flex on 429 and fails over to the regular model", async () => {
    process.env.OPENAI_API_KEY = "test-gateway-key";
    const seen: string[] = [];
    let flexFailures = 0;
    const gateway = await startHttpServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => (body += chunk));
      request.on("end", () => {
        const model = (JSON.parse(body) as { model: string }).model;
        seen.push(model);
        response.setHeader("content-type", "application/json");
        if (model === "openai.gpt-6-astra-flex" && flexFailures < 5) {
          flexFailures += 1;
          response.statusCode = 429;
          response.end(JSON.stringify({ error: { message: "resource unavailable" } }));
          return;
        }
        response.end(JSON.stringify({ model, ok: true }));
      });
    });
    const route = modelRouteFromConfig({
      authorization_env: "OPENAI_API_KEY",
      model: {
        description: "GPT-6 Astra via the AI gateway",
        display_name: "GPT-6 Astra",
        priority: 1,
        slug: "gpt-6-astra",
        template_slug: "gpt-6-astra",
      },
      upstream: `${gateway.origin}/openai/v1`,
      transport: "http",
      targets: [
        { upstream_model: "openai.gpt-6-astra-flex", attempts: 3 },
        { upstream_model: "openai.gpt-6-astra" },
      ],
      retry: { on_status: [429], backoff_ms: [0], breaker: { failures: 1, cooldown_ms: 300_000 } },
    });
    const captures = new MemoryCaptureSink();
    const proxy = await startRoutingProxy(gateway.origin, captures, { routes: [route] });

    const first = await fetch(`${proxy.origin}/backend-api/codex/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-6-astra", input: "hello" }),
    });

    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ model: "openai.gpt-6-astra", ok: true });
    expect(seen).toEqual([
      "openai.gpt-6-astra-flex",
      "openai.gpt-6-astra-flex",
      "openai.gpt-6-astra-flex",
      "openai.gpt-6-astra",
    ]);
    expect(captures.events[0]?.routing).toMatchObject({
      action: "routed",
      requestedModel: "gpt-6-astra",
      upstreamModel: "openai.gpt-6-astra",
      attempts: [
        { upstreamModel: "openai.gpt-6-astra-flex", outcome: "retry", status: 429 },
        { upstreamModel: "openai.gpt-6-astra-flex", outcome: "retry", status: 429 },
        { upstreamModel: "openai.gpt-6-astra-flex", outcome: "retry", status: 429 },
        { upstreamModel: "openai.gpt-6-astra", outcome: "served", status: 200 },
      ],
    });

    // The flex breaker opened after the exhausted episode: the next request
    // goes straight to the regular model.
    const second = await fetch(`${proxy.origin}/backend-api/codex/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-6-astra", input: "again" }),
    });

    expect(second.status).toBe(200);
    expect(seen).toEqual([
      "openai.gpt-6-astra-flex",
      "openai.gpt-6-astra-flex",
      "openai.gpt-6-astra-flex",
      "openai.gpt-6-astra",
      "openai.gpt-6-astra",
    ]);
    expect(captures.events[1]?.routing?.attempts).toEqual([
      { upstreamModel: "openai.gpt-6-astra-flex", outcome: "breaker-open" },
      {
        upstreamModel: "openai.gpt-6-astra",
        outcome: "served",
        status: 200,
        durationMs: expect.any(Number),
      },
    ]);
    delete process.env.OPENAI_API_KEY;
  });

  it("observes the upstream models response and applies adjustments", async () => {
    const chatgpt = await startHttpServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          models: [
            {
              slug: "gpt-5.6-terra",
              display_name: "GPT-5.6 Terra",
              priority: 1,
              context_window: 272000,
              model_messages: {
                instructions_template: "base instructions",
                token_budget: { enabled: false, reminder_threshold_tokens: 6144 },
              },
            },
          ],
        }),
      );
    });
    const cache = new MemoryUpstreamCache();
    const proxy = await startRoutingProxy(chatgpt.origin, new MemoryCaptureSink(), {
      adjustments: [
        {
          slug: "gpt-5.6-terra",
          overrides: {
            context_window: 1_000_000,
            model_messages: { token_budget: { reminder_threshold_tokens: 8192 } },
          },
        },
      ],
      upstreamCache: cache,
    });

    const response = await fetch(`${proxy.origin}/backend-api/codex/models`);

    expect(response.status).toBe(200);
    const body = (await response.json()) as { models: Array<Record<string, unknown>> };
    expect(body.models[0]).toMatchObject({
      slug: "gpt-5.6-terra",
      context_window: 1_000_000,
      model_messages: {
        instructions_template: "base instructions",
        token_budget: { enabled: false, reminder_threshold_tokens: 8192 },
      },
    });
    // The cache holds the original, unadjusted upstream body.
    expect(cache.state.models).toMatchObject({
      body: { models: [{ slug: "gpt-5.6-terra", context_window: 272000 }] },
    });
  });

  it("applies message transformations to upstream model instruction strings", async () => {
    const chatgpt = await startHttpServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          models: [
            {
              slug: "gpt-5.6-terra",
              model_messages: {
                instructions_template: "You are Codex, an agent based on GPT-5. Be helpful.",
                token_budget: { guidance_message: "Use notes to checkpoint." },
              },
            },
          ],
        }),
      );
    });
    const proxy = await startRoutingProxy(chatgpt.origin, new MemoryCaptureSink(), {
      transformations: [
        {
          id: "trim-base",
          name: "Trim base",
          enabled: true,
          scope: {},
          target: { field: "message_text", identifier: "segment:codex_base" },
          operation: { type: "replace_all", find: "Be helpful.", replacement: "Be terse." },
        },
      ],
    });

    const response = await fetch(`${proxy.origin}/backend-api/codex/models`);

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      models: Array<{ model_messages: Record<string, unknown> }>;
    };
    expect(body.models[0]?.model_messages).toMatchObject({
      instructions_template: "You are Codex, an agent based on GPT-5. Be terse.",
      token_budget: { guidance_message: "Use notes to checkpoint." },
    });
  });

  it("passes the models response through untouched when no transformation matches", async () => {
    const chatgpt = await startHttpServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.setHeader("etag", '"upstream-etag"');
      response.end(JSON.stringify({ models: [{ slug: "gpt-5.6-terra" }] }));
    });
    const proxy = await startRoutingProxy(chatgpt.origin, new MemoryCaptureSink(), {
      transformations: [
        {
          id: "trim-base",
          name: "Trim base",
          enabled: true,
          scope: {},
          target: { field: "message_text", identifier: "segment:codex_base" },
          operation: { type: "delete_part" },
        },
      ],
    });

    const response = await fetch(`${proxy.origin}/backend-api/codex/models`);

    expect(response.status).toBe(200);
    expect(response.headers.get("etag")).toBe('"upstream-etag"');
    expect(await response.json()).toEqual({ models: [{ slug: "gpt-5.6-terra" }] });
  });

  it("observes the upstream config bundle on passthrough", async () => {
    const chatgpt = await startHttpServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ requirements_toml: "managed = true" }));
    });
    const cache = new MemoryUpstreamCache();
    const proxy = await startRoutingProxy(chatgpt.origin, new MemoryCaptureSink(), {
      upstreamCache: cache,
    });

    const response = await fetch(`${proxy.origin}/backend-api/wham/config/bundle`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ requirements_toml: "managed = true" });
    expect(cache.state.configBundle).toMatchObject({
      body: { requirements_toml: "managed = true" },
    });
  });

  it("observes the upstream bundle while answering with the override", async () => {
    const chatgpt = await startHttpServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ requirements_toml: "managed = true" }));
    });
    const cache = new MemoryUpstreamCache();
    const proxy = await startRoutingProxy(chatgpt.origin, new MemoryCaptureSink(), {
      bundleOverride: { version: 1, enabled: true, bundle: { requirements_toml: null } },
      upstreamCache: cache,
    });

    const response = await fetch(`${proxy.origin}/backend-api/wham/config/bundle`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ requirements_toml: null });
    await eventually(() =>
      expect(cache.state.configBundle).toMatchObject({
        body: { requirements_toml: "managed = true" },
      }),
    );
  });

  it("routes a WebSocket response.create by the first message model", async () => {
    process.env.ACT_TEST_ROUTE_KEY = "local-api-key";
    try {
      const chatgpt = await startWebSocketServer((socket) => {
        socket.on("message", () => socket.send("chatgpt"));
      });
      const routed = await startWebSocketServer((socket, request) => {
        expect(request.url).toBe("/v1/responses");
        expect(request.headers.authorization).toBe("Bearer local-api-key");
        expect(request.headers["chatgpt-account-id"]).toBeUndefined();
        socket.on("message", (message) => {
          expect(JSON.parse(rawDataText(message))).toMatchObject({ model: "moonshot-kimi-k3" });
          socket.send("routed");
        });
      });
      const captures = new MemoryCaptureSink();
      const proxy = await startRoutingProxy(chatgpt.origin, captures, {
        routes: [testRoute(routed.origin)],
      });
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

      client.send(JSON.stringify({ type: "response.create", model: "kimi-k3", input: [] }));

      expect(await nextMessage(client)).toBe("routed");
      await eventually(() => expect(captures.events.length).toBeGreaterThanOrEqual(1));
      expect(captures.events[0]).toMatchObject({
        direction: "client_to_upstream",
        routing: {
          action: "routed",
          routeSlugs: ["kimi-k3"],
          upstream: routed.origin,
          requestedModel: "kimi-k3",
          upstreamModel: "moonshot-kimi-k3",
        },
      });
    } finally {
      delete process.env.ACT_TEST_ROUTE_KEY;
    }
  });

  it("bridges a WebSocket response.create to an HTTP-only route and streams SSE back", async () => {
    process.env.OPENAI_API_KEY = "test-gateway-key";
    try {
      const seen: string[] = [];
      const gateway = await startHttpServer((request, response) => {
        let body = "";
        request.on("data", (chunk) => (body += chunk));
        request.on("end", () => {
          const payload = JSON.parse(body) as Record<string, unknown>;
          seen.push(String(payload.model));
          expect(request.headers.authorization).toBe("Bearer test-gateway-key");
          expect(payload.stream).toBe(true);
          expect(payload.type).toBeUndefined();
          expect(payload.client_metadata).toBeUndefined();
          expect(payload.generate).toBeUndefined();
          response.setHeader("content-type", "text/event-stream");
          response.end(
            `event: response.created\ndata: {"type":"response.created","response":{"id":"resp_gw","model":"${String(payload.model)}","status":"in_progress"}}\n\n` +
              `event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"audit-ok"}\n\n` +
              `event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_gw","model":"${String(payload.model)}","status":"completed"}}\n\n`,
          );
        });
      });
      const route = modelRouteFromConfig({
        authorization_env: "OPENAI_API_KEY",
        model: {
          description: "GPT-6 Astra via the AI gateway",
          display_name: "GPT-6 Astra",
          priority: 1,
          slug: "gpt-6-astra",
          template_slug: "gpt-6-astra",
        },
        upstream: `${gateway.origin}/openai/v1`,
        transport: "http",
        targets: [
          { upstream_model: "openai.gpt-6-astra-flex", attempts: 2 },
          { upstream_model: "openai.gpt-6-astra" },
        ],
        retry: { on_status: [429], backoff_ms: [0] },
      });
      const captures = new MemoryCaptureSink();
      const chatgpt = await startWebSocketServer((socket) => {
        socket.on("message", () => socket.send("chatgpt"));
      });
      const proxy = await startRoutingProxy(chatgpt.origin, captures, { routes: [route] });
      const client = new WebSocket(
        proxy.origin.replace("http://", "ws://") + "/backend-api/codex/responses",
        { headers: { authorization: "Bearer oauth-secret" } },
      );
      closeables.push(async () => client.close());
      await opened(client);

      client.send(
        JSON.stringify({
          type: "response.create",
          client_metadata: { session_id: "s" },
          model: "gpt-6-astra",
          input: [],
        }),
      );

      const created = JSON.parse(await nextMessage(client)) as {
        type: string;
        response: { id: string; model: string };
      };
      expect(created.type).toBe("response.created");
      expect(created.response.model).toBe("gpt-6-astra");
      expect(created.response.id).toBe("");
      const delta = JSON.parse(await nextMessage(client)) as { type: string };
      expect(delta.type).toBe("response.output_text.delta");
      const completed = JSON.parse(await nextMessage(client)) as {
        type: string;
        response: { id: string; model: string };
      };
      expect(completed.type).toBe("response.completed");
      expect(completed.response.model).toBe("gpt-6-astra");
      expect(completed.response.id).toBe("");

      expect(seen).toEqual(["openai.gpt-6-astra-flex"]);
      await eventually(() => expect(captures.events.length).toBeGreaterThanOrEqual(4));
      expect(captures.events[0]).toMatchObject({
        direction: "client_to_upstream",
        routing: {
          action: "routed",
          requestedModel: "gpt-6-astra",
          upstreamModel: "openai.gpt-6-astra-flex",
          attempts: [{ upstreamModel: "openai.gpt-6-astra-flex", outcome: "served", status: 200 }],
        },
      });
    } finally {
      delete process.env.OPENAI_API_KEY;
    }
  });

  it("fails over a bridged SSE rate_limit_exceeded to the regular model", async () => {
    process.env.OPENAI_API_KEY = "test-gateway-key";
    try {
      const seen: string[] = [];
      const gateway = await startHttpServer((request, response) => {
        let body = "";
        request.on("data", (chunk) => (body += chunk));
        request.on("end", () => {
          const model = String((JSON.parse(body) as { model: string }).model);
          seen.push(model);
          response.setHeader("content-type", "text/event-stream");
          if (model.endsWith("-flex")) {
            response.end(
              `data: {"type":"response.created","response":{"status":"in_progress"}}\n\n` +
                `data: {"type":"error","error":{"code":"rate_limit_exceeded","message":"We're currently processing too many requests — please try again later."}}\n\n` +
                `data: {"type":"response.failed","response":{"status":"failed","error":{"code":"rate_limit_exceeded"}}}\n\n`,
            );
            return;
          }
          response.end(
            `data: {"type":"response.created","response":{"id":"resp_std","model":"${model}","status":"in_progress"}}\n\n` +
              `data: {"type":"response.output_text.delta","delta":"ok"}\n\n` +
              `data: {"type":"response.completed","response":{"id":"resp_std","model":"${model}","status":"completed"}}\n\n`,
          );
        });
      });
      const route = modelRouteFromConfig({
        authorization_env: "OPENAI_API_KEY",
        model: {
          description: "GPT-6 Astra via the AI gateway",
          display_name: "GPT-6 Astra",
          priority: 1,
          slug: "gpt-6-astra",
          template_slug: "gpt-6-astra",
        },
        upstream: `${gateway.origin}/openai/v1`,
        transport: "http",
        targets: [
          { upstream_model: "openai.gpt-6-astra-flex", attempts: 2 },
          { upstream_model: "openai.gpt-6-astra" },
        ],
        retry: { on_status: [429], backoff_ms: [0] },
      });
      const captures = new MemoryCaptureSink();
      const chatgpt = await startWebSocketServer((socket) => {
        socket.on("message", () => socket.send("chatgpt"));
      });
      const proxy = await startRoutingProxy(chatgpt.origin, captures, { routes: [route] });
      const client = new WebSocket(
        proxy.origin.replace("http://", "ws://") + "/backend-api/codex/responses",
        { headers: { authorization: "Bearer oauth-secret" } },
      );
      closeables.push(async () => client.close());
      await opened(client);

      client.send(JSON.stringify({ type: "response.create", model: "gpt-6-astra", input: [] }));

      const created = JSON.parse(await nextMessage(client)) as { type: string };
      expect(created.type).toBe("response.created");
      expect(JSON.parse(await nextMessage(client))).toMatchObject({
        type: "response.output_text.delta",
        delta: "ok",
      });
      expect(seen).toEqual([
        "openai.gpt-6-astra-flex",
        "openai.gpt-6-astra-flex",
        "openai.gpt-6-astra",
      ]);
      await eventually(() =>
        expect(captures.events[0]).toMatchObject({
          direction: "client_to_upstream",
          routing: {
            requestedModel: "gpt-6-astra",
            upstreamModel: "openai.gpt-6-astra",
            attempts: [
              { upstreamModel: "openai.gpt-6-astra-flex", outcome: "retry", status: 429 },
              { upstreamModel: "openai.gpt-6-astra-flex", outcome: "retry", status: 429 },
              { upstreamModel: "openai.gpt-6-astra", outcome: "served", status: 200 },
            ],
          },
        }),
      );
    } finally {
      delete process.env.OPENAI_API_KEY;
    }
  });

  it("answers a bridged generate:false warmup locally without touching the gateway", async () => {
    process.env.OPENAI_API_KEY = "test-gateway-key";
    try {
      let gatewayRequests = 0;
      const gateway = await startHttpServer((_request, response) => {
        gatewayRequests += 1;
        response.statusCode = 500;
        response.end("should not be called");
      });
      const route = modelRouteFromConfig({
        authorization_env: "OPENAI_API_KEY",
        model: {
          description: "GPT-6 Astra via the AI gateway",
          display_name: "GPT-6 Astra",
          priority: 1,
          slug: "gpt-6-astra",
          template_slug: "gpt-6-astra",
        },
        upstream: `${gateway.origin}/openai/v1`,
        transport: "http",
        targets: [{ upstream_model: "openai.gpt-6-astra-flex" }],
      });
      const captures = new MemoryCaptureSink();
      const chatgpt = await startWebSocketServer((socket) => {
        socket.on("message", () => socket.send("chatgpt"));
      });
      const proxy = await startRoutingProxy(chatgpt.origin, captures, { routes: [route] });
      const client = new WebSocket(
        proxy.origin.replace("http://", "ws://") + "/backend-api/codex/responses",
        { headers: { authorization: "Bearer oauth-secret" } },
      );
      closeables.push(async () => client.close());
      await opened(client);

      client.send(
        JSON.stringify({ type: "response.create", generate: false, model: "gpt-6-astra" }),
      );

      const created = JSON.parse(await nextMessage(client)) as {
        type: string;
        response: { model: string; status: string };
      };
      expect(created.type).toBe("response.created");
      expect(created.response).toMatchObject({ model: "gpt-6-astra", status: "in_progress" });
      const completed = JSON.parse(await nextMessage(client)) as {
        type: string;
        response: { model: string; status: string };
      };
      expect(completed.type).toBe("response.completed");
      expect(completed.response).toMatchObject({ model: "gpt-6-astra", status: "completed" });

      expect(gatewayRequests).toBe(0);
      await eventually(() => expect(captures.events.length).toBeGreaterThanOrEqual(3));
      expect(captures.events[0]).toMatchObject({
        direction: "client_to_upstream",
        routing: { action: "routed", requestedModel: "gpt-6-astra" },
      });
    } finally {
      delete process.env.OPENAI_API_KEY;
    }
  });

  it("sends a wrapped error event when every bridged target is exhausted", async () => {
    process.env.OPENAI_API_KEY = "test-gateway-key";
    try {
      const gateway = await startHttpServer((_request, response) => {
        response.statusCode = 429;
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({ error: { code: "resource_unavailable", message: "no flex" } }),
        );
      });
      const route = modelRouteFromConfig({
        authorization_env: "OPENAI_API_KEY",
        model: {
          description: "GPT-6 Astra via the AI gateway",
          display_name: "GPT-6 Astra",
          priority: 1,
          slug: "gpt-6-astra",
          template_slug: "gpt-6-astra",
        },
        upstream: `${gateway.origin}/openai/v1`,
        transport: "http",
        targets: [{ upstream_model: "openai.gpt-6-astra-flex", attempts: 2 }],
        retry: { on_status: [429], backoff_ms: [0] },
      });
      const captures = new MemoryCaptureSink();
      const chatgpt = await startWebSocketServer((socket) => {
        socket.on("message", () => socket.send("chatgpt"));
      });
      const proxy = await startRoutingProxy(chatgpt.origin, captures, {
        routes: [route],
      });
      const client = new WebSocket(
        proxy.origin.replace("http://", "ws://") + "/backend-api/codex/responses",
        { headers: { authorization: "Bearer oauth-secret" } },
      );
      closeables.push(async () => client.close());
      await opened(client);

      client.send(JSON.stringify({ type: "response.create", model: "gpt-6-astra", input: [] }));

      const error = JSON.parse(await nextMessage(client)) as {
        type: string;
        status: number;
        error: { code: string; message: string };
      };
      expect(error).toEqual({
        type: "error",
        status: 429,
        error: { code: "resource_unavailable", message: "no flex" },
      });
      await eventually(() =>
        expect(captures.events.some((event) => event.errorSummary !== undefined)).toBe(true),
      );
      expect(
        captures.events.find((event) => event.direction === "upstream_to_client"),
      ).toMatchObject({
        origin: {
          kind: "gateway-http",
          url: `${gateway.origin}/openai/v1/responses`,
        },
        errorSummary: {
          eventType: "error",
          status: 429,
          code: "resource_unavailable",
          message: "no flex",
        },
      });

      // The socket survives: an unrouted model still flows to the default WS upstream.
      client.send(JSON.stringify({ type: "response.create", model: "gpt-5.6-terra", input: [] }));
      expect(await nextMessage(client)).toBe("chatgpt");
    } finally {
      delete process.env.OPENAI_API_KEY;
    }
  });

  it("keeps unmatched WebSocket models on the default upstream", async () => {
    const chatgpt = await startWebSocketServer((socket, request) => {
      expect(request.headers.authorization).toBe("Bearer oauth-secret");
      socket.on("message", () => socket.send("chatgpt"));
    });
    const proxy = await startRoutingProxy(chatgpt.origin, new MemoryCaptureSink(), {
      routes: [testRoute("http://127.0.0.1:1")],
    });
    const client = new WebSocket(
      proxy.origin.replace("http://", "ws://") + "/backend-api/codex/responses",
      { headers: { authorization: "Bearer oauth-secret" } },
    );
    closeables.push(async () => client.close());
    await opened(client);

    client.send(JSON.stringify({ type: "response.create", model: "gpt-5.6", input: [] }));

    expect(await nextMessage(client)).toBe("chatgpt");
  });
});

describe("sanitizeCloseCode", () => {
  it("keeps valid codes and drops reserved ones", () => {
    expect(sanitizeCloseCode(1000)).toBe(1000);
    expect(sanitizeCloseCode(1011)).toBe(1011);
    expect(sanitizeCloseCode(3000)).toBe(3000);
    expect(sanitizeCloseCode(1004)).toBeUndefined();
    expect(sanitizeCloseCode(1005)).toBeUndefined();
    expect(sanitizeCloseCode(1006)).toBeUndefined();
    expect(sanitizeCloseCode(1015)).toBeUndefined();
    expect(sanitizeCloseCode(2999)).toBeUndefined();
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

async function startRoutingProxy(
  upstreamOrigin: string,
  captureSink: CaptureSink,
  options: {
    routes?: ModelRoute[];
    adjustments?: ModelAdjustment[];
    fixturePins?: string[];
    fixtureModels?: ModelDefinition[];
    bundleOverride?: ConfigBundleOverride;
    upstreamCache?: MemoryUpstreamCache;
    transformations?: Transformation[];
  } = {},
): Promise<RunningProxy> {
  const proxy = await startReverseProxy({
    host: "127.0.0.1",
    port: 0,
    upstreamOrigin,
    captureSink,
    transformationSource: { get: () => options.transformations ?? [] },
    modelRouteSource: {
      get: () => ({
        routes: options.routes ?? [],
        adjustments: options.adjustments ?? [],
        fixturePins: options.fixturePins ?? [],
      }),
    },
    ...(options.fixtureModels === undefined ? {} : { fixtureModels: options.fixtureModels }),
    configBundleSource: {
      get: () => options.bundleOverride ?? { version: 1, enabled: false, bundle: null },
    },
    ...(options.upstreamCache === undefined ? {} : { upstreamCache: options.upstreamCache }),
  });
  closeables.push(() => proxy.close());
  return proxy;
}

class MemoryUpstreamCache implements UpstreamCacheStore {
  state: UpstreamCacheState = {};

  get(): UpstreamCacheState {
    return this.state;
  }

  async observe(kind: UpstreamCacheKind, body: unknown) {
    this.state = { ...this.state, [kind]: { fetchedAt: new Date().toISOString(), body } };
  }
}

function testRoute(upstreamOrigin: string): ModelRoute {
  return {
    ...modelRouteFromConfig({
      authorization_env: "ACT_TEST_ROUTE_KEY",
      model: {
        description: "Kimi K3 via CLIProxyAPI",
        display_name: "Kimi K3",
        priority: 1,
        slug: "kimi-k3",
        template_slug: "gpt-5.6-terra",
      },
      upstream: `${upstreamOrigin}/v1`,
      upstream_model: "moonshot-kimi-k3",
    }),
  };
}

function message(role: string, text: string) {
  return { type: "message", role, content: [{ type: "input_text", text }] };
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
