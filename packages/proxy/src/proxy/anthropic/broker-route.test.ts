import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { modelRouteFromConfig } from "../../routing/model-routes.ts";
import { LiveRequestStore } from "../../requests/live-request-store.ts";
import { startReverseProxy, type RunningProxy } from "../server.ts";

const closeables: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const close of closeables.splice(0).reverse()) await close();
  delete process.env.CLAUDE_BROKER_TEST_KEY;
  delete process.env.OPENAI_BROKER_TEST_KEY;
  vi.restoreAllMocks();
});

describe("broker route validation on both client transports", () => {
  it("uses the plain adapter when web_search is not declared", async () => {
    process.env.CLAUDE_BROKER_TEST_KEY = "test-token";
    let served = 0;
    const gateway = Bun.serve({
      port: 0,
      async fetch() {
        served++;
        return Response.json({
          type: "message",
          content: [{ type: "text", text: "plain reply" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 2 },
        });
      },
    });
    closeables.push(() => gateway.stop(true));
    const claude = modelRouteFromConfig({
      api: "anthropic-messages",
      authorization_env: "CLAUDE_BROKER_TEST_KEY",
      upstream: `${gateway.url.origin}/anthropic`,
      model: {
        slug: "claude-test",
        display_name: "Claude test",
        description: "Test route",
        template_slug: "gpt-6-astra",
        priority: 1,
      },
      tool_policy: { web_search: "broker" },
    });
    const proxy = await startReverseProxy({
      port: 0,
      upstreamOrigin: "https://upstream.example",
      captureSink: { async record() {} },
      anthropicKey: new Uint8Array(32),
      modelRouteSource: { get: () => ({ routes: [claude], adjustments: [], fixturePins: [] }) },
      proxyConfigSource: {
        get: () => ({
          version: 1,
          appsAuthRelay: false,
          local_policy_override: false,
          search_broker: { route: "missing-search" },
          routed_agents: { enabled: false, prefer_native_spawn_models: false },
        }),
        subscribe: () => () => {},
      },
    });
    closeables.push(() => proxy.close());
    const payload = {
      model: claude.model.slug,
      input: [{ role: "user", content: "Say hello" }],
      tools: [{ type: "function", name: "noop", parameters: { type: "object" } }],
    };
    const http = await fetch(`${proxy.origin}/backend-api/codex/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...payload, stream: false }),
    });
    expect(http.status).toBe(200);
    expect(JSON.stringify(await http.json())).toContain("plain reply");

    const ws = new WebSocket(`${proxy.origin.replace("http:", "ws:")}/backend-api/codex/responses`);
    closeables.push(() => ws.close());
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = reject;
    });
    const terminal = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("WebSocket timeout")), 5000);
      ws.onmessage = (event) => {
        const data = JSON.parse(String(event.data)) as Record<string, unknown>;
        if (!["response.completed", "response.failed", "error"].includes(String(data.type))) return;
        clearTimeout(timer);
        resolve(data);
      };
      ws.send(JSON.stringify({ type: "response.create", ...payload, stream: true }));
    });
    expect(terminal.type).toBe("response.completed");
    expect(served).toBe(2);
  });

  it("reports a missing configured search route on HTTP and WebSocket", async () => {
    process.env.CLAUDE_BROKER_TEST_KEY = "test-token";
    const claude = modelRouteFromConfig({
      api: "anthropic-messages",
      authorization_env: "CLAUDE_BROKER_TEST_KEY",
      upstream: "https://claude.example/anthropic",
      model: {
        slug: "claude-test",
        display_name: "Claude test",
        description: "Test route",
        template_slug: "gpt-6-astra",
        priority: 1,
      },
      tool_policy: { web_search: "broker" },
    });
    const proxy: RunningProxy = await startReverseProxy({
      port: 0,
      upstreamOrigin: "https://upstream.example",
      captureSink: { async record() {} },
      anthropicKey: new Uint8Array(32),
      modelRouteSource: { get: () => ({ routes: [claude], adjustments: [], fixturePins: [] }) },
      proxyConfigSource: {
        get: () => ({
          version: 1,
          appsAuthRelay: false,
          local_policy_override: false,
          search_broker: { route: "missing-search" },
          routed_agents: { enabled: false, prefer_native_spawn_models: false },
        }),
        subscribe: () => () => {},
      },
    });
    closeables.push(() => proxy.close());
    const payload = {
      model: "claude-test",
      stream: true,
      input: [{ role: "user", content: "Search for one fact" }],
      tools: [{ type: "web_search" }],
    };
    const http = await fetch(`${proxy.origin}/backend-api/codex/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    expect(http.status).toBe(400);
    expect(await http.text()).toContain('route "missing-search"');

    const ws = new WebSocket(`${proxy.origin.replace("http:", "ws:")}/backend-api/codex/responses`);
    closeables.push(() => ws.close());
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = reject;
    });
    const error = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("WebSocket timeout")), 5000);
      ws.onmessage = (event) => {
        clearTimeout(timer);
        resolve(JSON.parse(String(event.data)) as Record<string, unknown>);
      };
      ws.send(JSON.stringify({ type: "response.create", ...payload }));
    });
    expect(JSON.stringify(error)).toContain("missing-search");
  });

  it("brokers through the HTTP bridge and replays after a broker error", async () => {
    process.env.CLAUDE_BROKER_TEST_KEY = "claude-token";
    process.env.OPENAI_BROKER_TEST_KEY = "search-token";
    const seen: Record<string, unknown>[] = [];
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const liveRequests = new LiveRequestStore();
    const privateError = "private-search-query-and-internal-url";
    const gateway = Bun.serve({
      port: 0,
      async fetch(request) {
        const path = new URL(request.url).pathname;
        const body = (await request.json()) as Record<string, unknown>;
        if (path === "/openai/responses") {
          expect(request.headers.get("authorization")).toBe("Bearer search-token");
          return Response.json({ error: { message: privateError } }, { status: 503 });
        }
        expect(request.headers.get("authorization")).toBe("Bearer claude-token");
        seen.push(body);
        if (seen.length === 1)
          return Response.json({
            type: "message",
            content: [
              { type: "tool_use", id: "toolu_error", name: "web_search", input: { query: "fact" } },
            ],
            stop_reason: "tool_use",
            usage: { input_tokens: 4, output_tokens: 3 },
          });
        return Response.json({
          type: "message",
          content: [{ type: "text", text: "Search is unavailable; I can still answer." }],
          stop_reason: "end_turn",
          usage: { input_tokens: 8, output_tokens: 5 },
        });
      },
    });
    closeables.push(() => gateway.stop(true));
    const claude = modelRouteFromConfig({
      api: "anthropic-messages",
      authorization_env: "CLAUDE_BROKER_TEST_KEY",
      upstream: `${gateway.url.origin}/anthropic`,
      model: {
        slug: "claude-test",
        display_name: "Claude test",
        description: "Test route",
        template_slug: "gpt-6-astra",
        priority: 1,
      },
      tool_policy: { web_search: "broker" },
    });
    const search = modelRouteFromConfig({
      authorization_env: "OPENAI_BROKER_TEST_KEY",
      upstream: `${gateway.url.origin}/openai`,
      transport: "http",
      model: {
        slug: "gpt-6-luna",
        display_name: "Search test",
        description: "Test route",
        template_slug: "gpt-6-astra",
        priority: 1,
      },
    });
    const proxy = await startReverseProxy({
      port: 0,
      upstreamOrigin: "https://upstream.example",
      captureSink: { async record() {} },
      anthropicKey: new Uint8Array(32),
      modelRouteSource: {
        get: () => ({ routes: [claude, search], adjustments: [], fixturePins: [] }),
      },
      liveRequests,
    });
    closeables.push(() => proxy.close());
    const post = (input: unknown[]) =>
      fetch(`${proxy.origin}/backend-api/codex/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: claude.model.slug,
          stream: false,
          input,
          tools: [{ type: "web_search" }],
        }),
      });
    const initialInput = [{ role: "user", content: "Find a fact" }];
    const first = await post(initialInput);
    expect(first.status).toBe(200);
    const completed = (await first.json()) as { output: Record<string, unknown>[] };
    expect(completed.output.map((item) => item.type)).toEqual([
      "web_search_call",
      "reasoning",
      "message",
    ]);
    expect(JSON.stringify(seen[1]!.messages)).toContain("HTTP 503");
    expect(JSON.stringify(seen[1]!.messages)).toContain('"is_error":true');
    expect(JSON.stringify(seen[1]!.messages)).not.toContain(privateError);
    expect(JSON.stringify(liveRequests.snapshot())).not.toContain(privateError);
    expect(JSON.stringify(warning.mock.calls)).not.toContain(privateError);
    expect(
      liveRequests.snapshot().recent[0]?.events.some((entry) => entry.detail?.includes("HTTP 503")),
    ).toBe(true);
    const followup = await post([
      ...initialInput,
      ...completed.output,
      { role: "user", content: "Continue" },
    ]);
    expect(followup.status).toBe(200);
    expect(JSON.stringify(seen[2]!.messages)).toContain('"tool_use_id":"toolu_error"');
  });
});
