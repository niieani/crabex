import { afterEach, describe, expect, it } from "vite-plus/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  modelRouteFromConfig,
  parseModelRouteSet,
  responseTargetUrl,
} from "../../routing/model-routes.ts";
import { startReverseProxy, type RunningProxy } from "../server.ts";
import { parseSseEvents, resolveEventStreamResponse } from "../responses-bridge.ts";
import { AnthropicEnvelope, openAnthropicKey, type Json } from "./envelope.ts";
import { prepareAnthropic } from "./request.ts";
import { anthropicEvents } from "./response.ts";

const key = new Uint8Array(32).fill(42);
const route = modelRouteFromConfig({
  api: "anthropic-messages",
  authorization_env: "ANTHROPIC_TEST_TOKEN",
  upstream: "https://gateway.example/anthropic",
  upstream_model: "anthropic.claude-sonnet-5",
  model: {
    slug: "claude-test",
    display_name: "Claude",
    description: "Test",
    priority: 1,
    template_slug: "gpt-6-astra",
  },
});
const base = {
  model: "anthropic.claude-sonnet-5",
  input: [{ role: "user", content: "hello" }],
  stream: true,
};
const tool = { type: "custom", name: "apply_patch", description: "Patch a file" };
const message = (content: Json[], stop = "end_turn") => ({
  type: "message",
  content,
  stop_reason: stop,
  usage: {
    input_tokens: 11,
    cache_read_input_tokens: 5,
    cache_creation_input_tokens: 3,
    output_tokens: 7,
    output_tokens_details: { thinking_tokens: 2 },
  },
});
const sse = (events: Json[]) =>
  new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
async function converted(response: Response, payload: Json = base) {
  return Array.fromAsync(
    anthropicEvents(response, prepareAnthropic(payload, route, key), route.model.slug),
  ).then((events) => events.map((e) => JSON.parse(e)));
}

describe("Anthropic protocol", () => {
  it("translates discovery history and restores search and namespaced tool calls", async () => {
    const discoveryRoute = {
      ...route,
      toolPolicy: { ...route.toolPolicy, tool_search: "translate" as const },
    };
    const search = {
      type: "tool_search",
      execution: "client",
      description: "Find deferred tools",
      parameters: { type: "object", properties: { query: { type: "string" } } },
    };
    const discovered = {
      type: "namespace",
      name: "inventory",
      tools: [
        {
          type: "function",
          name: "lookup_item",
          description: "Look up a SKU",
          parameters: { type: "object" },
        },
      ],
    };
    const prepared = prepareAnthropic(
      {
        ...base,
        tools: [search, discovered],
        input: [
          { role: "user", content: "Find an inventory tool" },
          {
            type: "tool_search_call",
            call_id: "search_1",
            execution: "client",
            arguments: { query: "inventory" },
          },
          {
            type: "tool_search_output",
            call_id: "search_1",
            status: "completed",
            execution: "client",
            tools: [discovered],
          },
          {
            type: "function_call",
            call_id: "lookup_1",
            namespace: "inventory",
            name: "lookup_item",
            arguments: '{"sku":"A"}',
          },
          { type: "function_call_output", call_id: "lookup_1", output: "found" },
        ],
      },
      discoveryRoute,
      key,
    );
    const lookup = prepared.codec.tools.find((tool) => tool.namespace === "inventory")!;
    expect(prepared.body.tools).toMatchObject([
      { name: "tool_search", description: search.description },
      { name: lookup.wire, description: "Look up a SKU" },
    ]);
    expect(prepared.body.messages).toMatchObject([
      { role: "user" },
      {
        role: "assistant",
        content: [{ type: "tool_use", name: "tool_search", input: { query: "inventory" } }],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            content: [{ text: expect.stringContaining("inventory.lookup_item") }],
          },
        ],
      },
      {
        role: "assistant",
        content: [{ type: "tool_use", name: lookup.wire, input: { sku: "A" } }],
      },
      { role: "user", content: [{ type: "tool_result", content: [{ text: "found" }] }] },
    ]);

    const events = await Array.fromAsync(
      anthropicEvents(
        sse([
          { type: "message_start", message: { usage: {} } },
          {
            type: "content_block_start",
            index: 0,
            content_block: { type: "tool_use", id: "search_2", name: "tool_search", input: {} },
          },
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "input_json_delta", partial_json: '{"query":"inventory"}' },
          },
          { type: "content_block_stop", index: 0 },
          {
            type: "content_block_start",
            index: 1,
            content_block: { type: "tool_use", id: "lookup_2", name: lookup.wire, input: {} },
          },
          {
            type: "content_block_delta",
            index: 1,
            delta: { type: "input_json_delta", partial_json: '{"sku":"B"}' },
          },
          { type: "content_block_stop", index: 1 },
          { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: {} },
          { type: "message_stop" },
        ]),
        prepared,
        discoveryRoute.model.slug,
      ),
    );
    const parsed = events.map((event) => JSON.parse(event));
    const done = parsed.filter((event) => event.type === "response.output_item.done");
    expect(
      parsed.filter(
        (event) =>
          event.type === "response.function_call_arguments.delta" &&
          event.item_id === done[0].item.id,
      ),
    ).toHaveLength(0);
    expect(done[0].item).toMatchObject({
      type: "tool_search_call",
      call_id: "search_2",
      execution: "client",
      arguments: { query: "inventory" },
    });
    expect(done[1].item).toMatchObject({
      type: "function_call",
      namespace: "inventory",
      name: "lookup_item",
      arguments: '{"sku":"B"}',
    });
    expect(parsed.at(-1).response.output).toMatchObject([done[0].item, done[1].item]);
  });

  it("cancels upstream readers after terminal events and on consumer cancellation", async () => {
    let cancelled = false;
    const upstream = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              'data: {"type":"message_start","message":{}}\n\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\ndata: {"type":"message_stop"}\n\n',
            ),
          );
        },
        cancel() {
          cancelled = true;
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
    expect((await converted(upstream)).at(-1).type).toBe("response.completed");
    expect(cancelled).toBe(true);
  });
  it("retries overload before output but never after committing output", async () => {
    const before = await resolveEventStreamResponse(
      sse([
        { type: "response.created" },
        { type: "response.failed", response: { error: { code: "anthropic_overloaded" } } },
      ]),
    );
    expect(before).toEqual({ kind: "retry", status: 503 });
    const after = await resolveEventStreamResponse(
      sse([
        { type: "response.output_text.delta", delta: "started" },
        { type: "response.failed", response: { error: { code: "anthropic_overloaded" } } },
      ]),
    );
    expect(after.kind).toBe("ok");
    if (after.kind === "ok") expect(await after.response.text()).toContain("anthropic_overloaded");
  });
  it("honors adaptive effort, disabled and budget thinking plus explicit output caps", () => {
    expect(
      prepareAnthropic({ ...base, reasoning: { effort: "xhigh" } }, route, key).body,
    ).toMatchObject({ thinking: { type: "adaptive" }, output_config: { effort: "xhigh" } });
    expect(
      prepareAnthropic({ ...base, reasoning: { effort: "none" } }, route, key).body.thinking,
    ).toEqual({ type: "disabled" });
    expect(
      prepareAnthropic(
        { ...base, max_output_tokens: 2048 },
        { ...route, anthropic: { thinking: "budget", budget_tokens: 8192 } },
        key,
      ).body,
    ).toMatchObject({ max_tokens: 2048, thinking: { type: "enabled", budget_tokens: 2047 } });
    expect(() =>
      prepareAnthropic(
        { ...base, max_output_tokens: 12 },
        { ...route, anthropic: { thinking: "budget" } },
        key,
      ),
    ).toThrow("1024");
  });

  it("keeps required thinking during compaction and supports prefix changes", () => {
    const required = {
      ...route,
      anthropic: { thinking_required: true, drop_mismatched_thinking: true },
    };
    expect(prepareAnthropic(base, required, key, true).body).toMatchObject({
      thinking: { type: "adaptive", block_binding: { prefix_mismatch_behavior: "drop_block" } },
    });
    expect(() =>
      prepareAnthropic({ ...base, reasoning: { effort: "none" } }, required, key),
    ).toThrow("requires adaptive");
    expect(() =>
      prepareAnthropic({ ...base, tools: [tool], tool_choice: "required" }, required, key),
    ).toThrow("always-thinking");
    expect(() =>
      prepareAnthropic(
        base,
        { ...required, anthropic: { thinking_required: true, thinking: "budget" } },
        key,
      ),
    ).toThrow("requires adaptive");
  });

  it("wraps Desktop union tool schemas without changing their constraints", () => {
    const parameters = {
      type: "object",
      properties: {},
      oneOf: [{ $ref: "#/$defs/view" }],
      $defs: {
        view: { type: "object", properties: { mode: { const: "view" } }, required: ["mode"] },
      },
    };
    const prepared = prepareAnthropic(
      {
        ...base,
        tools: [
          {
            type: "namespace",
            name: "desktop",
            tools: [{ type: "function", name: "automation_update", parameters }],
          },
        ],
      },
      route,
      key,
    );
    const schema = prepared.tools[0]!.schema.input_schema as Json;
    expect(schema.oneOf).toBeUndefined();
    expect(schema.properties).toHaveProperty("arguments");
    expect((schema.properties as Json).arguments).toMatchObject({
      oneOf: [{ $ref: "#/properties/arguments/$defs/view" }],
      $defs: parameters.$defs,
    });
  });

  it("unwraps fragmented union tool arguments and restores the wrapper on replay", async () => {
    for (const union of ["oneOf", "anyOf", "allOf"]) {
      const payload = {
        ...base,
        tools: [
          {
            type: "function",
            name: "desktop_action",
            parameters: { [union]: [{ type: "object", properties: { mode: { type: "string" } } }] },
          },
        ],
      };
      const events = await converted(
        sse([
          { type: "message_start", message: {} },
          {
            type: "content_block_start",
            index: 0,
            content_block: { type: "tool_use", id: "call1", name: "desktop_action", input: {} },
          },
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "input_json_delta", partial_json: '{"arguments":' },
          },
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "input_json_delta", partial_json: '{"mode":"view"}}' },
          },
          { type: "content_block_stop", index: 0 },
          { type: "message_delta", delta: { stop_reason: "tool_use" } },
          { type: "message_stop" },
        ]),
        payload,
      );
      const output = events.at(-1).response.output;
      expect(output[0].arguments).toBe('{"mode":"view"}');
      expect(
        events
          .filter((e) => e.type === "response.function_call_arguments.delta")
          .map((e) => e.delta)
          .join(""),
      ).toBe('{"mode":"view"}');
      const replay = prepareAnthropic(
        {
          ...payload,
          input: [
            ...base.input,
            ...output,
            { type: "function_call_output", call_id: "call1", output: "done" },
          ],
        },
        route,
        key,
      );
      expect(replay.body.messages).toMatchObject([
        { role: "user" },
        {
          role: "assistant",
          content: [{ type: "tool_use", input: { arguments: { mode: "view" } } }],
        },
        { role: "user" },
      ]);
    }
  });

  it("validates routes and composes prefix URLs without duplicate v1 paths", () => {
    expect(route.transport).toBe("http");
    for (const path of ["/anthropic", "/anthropic/v1", "/anthropic/v1/messages"])
      expect(
        responseTargetUrl({ ...route, upstream: new URL(`https://gateway.example${path}`) }, "")
          .pathname,
      ).toBe("/anthropic/v1/messages");
    expect(() =>
      parseModelRouteSet([{ ...route, api: "anthropic-messages", transport: "ws" }]),
    ).toThrow("HTTP");
  });
  it("emits text lifecycle and cumulative cache-aware usage", async () => {
    const events = await converted(Response.json(message([{ type: "text", text: "hello" }])));
    expect(events.at(-1)).toMatchObject({
      type: "response.completed",
      response: {
        id: "",
        model: "claude-test",
        output: [{ type: "message", content: [{ text: "hello" }] }],
        usage: {
          input_tokens: 19,
          output_tokens: 7,
          total_tokens: 26,
          input_tokens_details: { cached_tokens: 5, cache_write_tokens: 3 },
          output_tokens_details: { reasoning_tokens: 2 },
        },
      },
    });
    expect(events.map((e) => e.sequence_number)).toEqual(events.map((_, i) => i));
    expect(events.some((e) => e.type === "response.output_item.done")).toBe(true);
  });
  it("roundtrips fragmented custom tools and exact signed thinking across reconstruction", async () => {
    const payload = { ...base, tools: [tool] };
    const events = await converted(
      sse([
        { type: "message_start", message: { usage: { input_tokens: 11 } } },
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "thinking", thinking: "" },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "thinking_delta", thinking: "Exact thought\n" },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "signature_delta", signature: "sig" },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "signature_delta", signature: "nature" },
        },
        { type: "content_block_stop", index: 0 },
        {
          type: "content_block_start",
          index: 1,
          content_block: { type: "tool_use", id: "toolu_1", name: "apply_patch", input: {} },
        },
        {
          type: "content_block_delta",
          index: 1,
          delta: { type: "input_json_delta", partial_json: '{"input":"*** Begin' },
        },
        {
          type: "content_block_delta",
          index: 1,
          delta: { type: "input_json_delta", partial_json: ' Patch\\n*** End Patch"}' },
        },
        { type: "content_block_stop", index: 1 },
        { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 15 } },
        { type: "message_stop" },
      ]),
      payload,
    );
    const output = events.at(-1).response.output;
    expect(output[1]).toMatchObject({
      type: "custom_tool_call",
      name: "apply_patch",
      input: "*** Begin Patch\n*** End Patch",
      call_id: "toolu_1",
    });
    expect(output[0].encrypted_content).not.toContain("Exact thought");
    const resumed = prepareAnthropic(
      {
        ...payload,
        input: [
          ...base.input,
          ...output,
          { type: "custom_tool_call_output", call_id: "toolu_1", output: "Applied" },
        ],
      },
      route,
      new Uint8Array(key),
    );
    expect(resumed.body.messages).toMatchObject([
      { role: "user" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Exact thought\n", signature: "signature" },
          { type: "tool_use", input: { input: "*** Begin Patch\n*** End Patch" } },
        ],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1" }] },
    ]);
  });
  it("keeps namespace tool names reversible and collision-free", async () => {
    const payload = {
      ...base,
      tools: [
        {
          type: "namespace",
          name: "mcp",
          tools: [
            { type: "function", name: "read", parameters: { type: "object", properties: {} } },
          ],
        },
        { type: "function", name: "read", parameters: { type: "object", properties: {} } },
      ],
    };
    const prepared = prepareAnthropic(payload, route, key);
    expect(prepared.tools[0]!.wire).not.toBe(prepared.tools[1]!.wire);
    const events = await converted(
      Response.json(
        message(
          [{ type: "tool_use", id: "toolu_2", name: prepared.tools[0]!.wire, input: {} }],
          "tool_use",
        ),
      ),
      payload,
    );
    expect(events.at(-1).response.output[0]).toMatchObject({
      type: "function_call",
      name: "read",
      namespace: "mcp",
      arguments: "{}",
    });
  });
  it("supports user and tool-result images without fetching arbitrary URLs", () => {
    const image = { type: "input_image", image_url: "data:image/png;base64,aGVsbG8=" };
    const prepared = prepareAnthropic(
      {
        ...base,
        input: [
          { role: "user", content: [image] },
          { type: "function_call", name: "view", call_id: "1", arguments: "{}" },
          { type: "function_call_output", call_id: "1", output: [image] },
        ],
      },
      route,
      key,
    );
    const messages = prepared.body.messages as { content: Json[] }[];
    expect(messages[0]!.content[0]).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" },
    });
    expect(messages[2]!.content[0]).toMatchObject({
      type: "tool_result",
      content: [{ type: "image" }],
    });
    expect(() =>
      prepareAnthropic(
        {
          ...base,
          input: [{ role: "user", content: [{ type: "input_image", file_id: "private" }] }],
        },
        route,
        key,
      ),
    ).toThrow("file IDs");
  });
  it("compacts to an authenticated replay item and resumes after reconstruction", async () => {
    const events = await converted(
      Response.json(
        message([{ type: "text", text: "User needs feature X; changed a.ts; tests pending." }]),
      ),
      { ...base, input: [...base.input, { type: "compaction_trigger" }] },
    );
    const output = events.at(-1).response.output;
    expect(output).toHaveLength(1);
    expect(output[0].type).toBe("compaction");
    expect(events.filter((e) => e.type === "response.output_item.done")).toHaveLength(1);
    const resumed = prepareAnthropic(
      { ...base, input: [...output, { role: "user", content: "Continue" }] },
      route,
      new Uint8Array(key),
    );
    expect(JSON.stringify(resumed.body)).toContain("tests pending");
    expect(() =>
      prepareAnthropic(
        { ...base, input: output },
        { ...route, upstream: new URL("https://other.example") },
        key,
      ),
    ).toThrow("decrypt");
    expect(() =>
      prepareAnthropic(
        { ...base, input: [{ type: "compaction", encrypted_content: "openai-opaque" }] },
        route,
        key,
      ),
    ).toThrow("another provider");
  });
  it("never completes truncated streams or max-token partial tool calls", async () => {
    const events = await converted(sse([{ type: "message_start", message: {} }]));
    expect(events.at(-1).type).toBe("response.failed");
    const limited = await converted(
      Response.json(message([{ type: "text", text: "partial" }], "max_tokens")),
    );
    expect(limited.at(-1).type).toBe("response.incomplete");
    expect(limited.some((e) => e.type === "response.output_item.done")).toBe(false);
    const overloaded = await converted(
      sse([{ type: "error", error: { type: "overloaded_error", message: "busy" } }]),
    );
    expect(overloaded.at(-1).response.error.code).toBe("anthropic_overloaded");
  });
  it("rejects broken tool history, unresolved continuations, and unsupported hosted tools", () => {
    expect(() =>
      prepareAnthropic({ ...base, previous_response_id: "resp_unknown" }, route, key),
    ).toThrow("full input replay");
    expect(() =>
      prepareAnthropic({ ...base, tools: [{ type: "web_search" }] }, route, key),
    ).toThrow("Unsupported");
    expect(() =>
      prepareAnthropic(
        {
          ...base,
          input: [
            ...base.input,
            { type: "function_call_output", call_id: "missing", output: "result" },
          ],
        },
        route,
        key,
      ),
    ).toThrow("Orphaned");
  });
  it("persists an authenticated key with rotation-independent replay", async () => {
    const dir = await mkdtemp(join(tmpdir(), "anthropic-key-"));
    try {
      const first = await openAnthropicKey(join(dir, "key"));
      const sealed = new AnthropicEnvelope(first, "scope").seal({
        kind: "compaction",
        summary: "hello",
      });
      const second = await openAnthropicKey(join(dir, "key"));
      expect(new AnthropicEnvelope(second, "scope").open(sealed).summary).toBe("hello");
      expect(() => new AnthropicEnvelope(key, "scope").open(sealed)).toThrow("decrypt");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

const closeables: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const close of closeables.splice(0).reverse()) await close();
  delete process.env.ANTHROPIC_TEST_TOKEN;
});
async function fixture() {
  const seen: { body: Json; headers: Headers; path: string }[] = [];
  let reply = message([{ type: "text", text: "audit-ok" }]);
  const gateway = Bun.serve({
    port: 0,
    async fetch(request) {
      seen.push({
        body: (await request.json()) as Json,
        headers: request.headers,
        path: new URL(request.url).pathname,
      });
      return Response.json(reply);
    },
  });
  closeables.push(() => gateway.stop(true));
  process.env.ANTHROPIC_TEST_TOKEN = "gateway-test-token";
  const localRoute = { ...route, upstream: new URL(`${gateway.url.origin}/anthropic`) };
  const start = async (): Promise<RunningProxy> => {
    const proxy = await startReverseProxy({
      port: 0,
      upstreamOrigin: gateway.url.origin,
      captureSink: { async record() {} },
      anthropicKey: key,
      modelRouteSource: { get: () => ({ routes: [localRoute], adjustments: [], fixturePins: [] }) },
    });
    closeables.push(() => proxy.close());
    return proxy;
  };
  return {
    seen,
    start,
    setReply(value: typeof reply) {
      reply = value;
    },
  };
}
describe("Anthropic proxy integration", () => {
  it("routes HTTP and legacy compaction, resuming the saved summary on a new proxy", async () => {
    const f = await fixture();
    const proxy = await f.start();
    const post = (origin: string, path: string, body: Json) =>
      fetch(`${origin}/backend-api/codex/responses${path}`, {
        method: "POST",
        headers: {
          authorization: "Bearer codex-oauth",
          "chatgpt-account-id": "secret-account",
          "content-type": "application/json",
        },
        body: JSON.stringify({ ...body, model: route.model.slug }),
      });
    const response = await post(proxy.origin, "", { ...base, stream: false });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ output: [{ content: [{ text: "audit-ok" }] }] });
    expect(f.seen[0]!.path).toBe("/anthropic/v1/messages");
    expect(f.seen[0]!.headers.get("authorization")).toBe("Bearer gateway-test-token");
    expect(f.seen[0]!.headers.get("chatgpt-account-id")).toBeNull();
    f.setReply(message([{ type: "text", text: "Remember project amber." }]));
    const compact = (await (await post(proxy.origin, "/compact", base)).json()) as {
      output: Json[];
    };
    expect(compact.output[0]!.type).toBe("compaction");
    const restarted = await f.start();
    const resumed = await post(restarted.origin, "", {
      ...base,
      stream: false,
      input: [...compact.output, { role: "user", content: "Continue" }],
    });
    expect(resumed.status).toBe(200);
    expect(JSON.stringify(f.seen.at(-1)!.body)).toContain("project amber");
  });
  it("answers websocket warmup locally, streams Responses, and replays on a new socket", async () => {
    const f = await fixture();
    const proxy = await f.start();
    const ws = new WebSocket(`${proxy.origin.replace("http:", "ws:")}/backend-api/codex/responses`);
    closeables.push(() => ws.close());
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = reject;
    });
    async function turn(payload: Json): Promise<Json[]> {
      return new Promise((resolve, reject) => {
        const events: Json[] = [];
        const timer = setTimeout(() => reject(new Error("WS timeout")), 5000);
        ws.onmessage = (event) => {
          const data = JSON.parse(String(event.data));
          events.push(data);
          if (["response.completed", "response.failed", "error"].includes(data.type)) {
            clearTimeout(timer);
            resolve(events);
          }
        };
        ws.send(JSON.stringify({ ...payload, type: "response.create", model: route.model.slug }));
      });
    }
    expect((await turn({ ...base, generate: false })).at(-1)!.type).toBe("response.completed");
    expect(f.seen).toHaveLength(0);
    expect((await turn(base)).at(-1)).toMatchObject({
      type: "response.completed",
      response: { id: "", output: [{ content: [{ text: "audit-ok" }] }] },
    });
    expect(f.seen).toHaveLength(1);
  });
  it("emits compaction through streaming HTTP", async () => {
    const f = await fixture();
    const proxy = await f.start();
    const response = await fetch(`${proxy.origin}/v1/responses`, {
      method: "POST",
      body: JSON.stringify({
        ...base,
        model: route.model.slug,
        input: [...base.input, { type: "compaction_trigger" }],
      }),
    });
    const events = await Array.fromAsync(parseSseEvents(response.body!));
    expect(JSON.parse(events.at(-1)!).response.output[0].type).toBe("compaction");
  });
});
