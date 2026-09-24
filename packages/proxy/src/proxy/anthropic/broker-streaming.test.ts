import { afterEach, describe, expect, it } from "vite-plus/test";
import { TargetBreakers } from "../../routing/failover.ts";
import { modelRouteFromConfig } from "../../routing/model-routes.ts";
import type { Json } from "./envelope.ts";
import { brokeredAnthropicEvents } from "./broker.ts";
import { prepareAnthropic } from "./request.ts";

const key = new Uint8Array(32).fill(14);
const claude = modelRouteFromConfig({
  api: "anthropic-messages",
  authorization_env: "CLAUDE_TEST_KEY",
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
const search = modelRouteFromConfig({
  authorization_env: "BROKER_STREAM_TEST_KEY",
  upstream: "https://search.example/v1",
  transport: "http",
  model: {
    slug: "gpt-6-luna",
    display_name: "Search test",
    description: "Test route",
    template_slug: "gpt-6-astra",
    priority: 1,
  },
});
const payload = {
  model: claude.model.slug,
  input: [{ role: "user", content: "Find a fact" }],
  tools: [{ type: "web_search" }],
  stream: true,
};
const wire = (value: Json) => `data: ${JSON.stringify(value)}\n\n`;
const sse = (values: Json[]) =>
  new Response(values.map(wire).join(""), { headers: { "content-type": "text/event-stream" } });
const context = (route = search) => ({ route, breakers: new TargetBreakers() });
const defer = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

afterEach(() => {
  delete process.env.BROKER_STREAM_TEST_KEY;
});

describe("brokered Anthropic stream", () => {
  it("forwards first-round text deltas before the upstream stream completes", async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const upstream = new Response(
      new ReadableStream<Uint8Array>({
        start(value) {
          controller = value;
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
    const prepared = prepareAnthropic(payload, claude, key);
    const events: Json[] = [];
    const delta = defer();
    const reading = (async () => {
      for await (const raw of brokeredAnthropicEvents(
        upstream,
        new URL("https://claude.example/anthropic/v1/messages"),
        new Headers(),
        prepared,
        claude.model.slug,
        context(),
      )) {
        const event = JSON.parse(raw) as Json;
        events.push(event);
        if (event.type === "response.output_text.delta") delta.resolve();
      }
    })();
    const encoder = new TextEncoder();
    controller.enqueue(
      encoder.encode(
        [
          { type: "message_start", message: { usage: { input_tokens: 1 } } },
          { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
          { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "early" } },
        ]
          .map(wire)
          .join(""),
      ),
    );
    const early = await Promise.race([
      delta.promise.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 100)),
    ]);
    controller.enqueue(
      encoder.encode(
        [
          { type: "content_block_stop", index: 0 },
          {
            type: "message_delta",
            delta: { stop_reason: "end_turn" },
            usage: { output_tokens: 1 },
          },
          { type: "message_stop" },
        ]
          .map(wire)
          .join(""),
      ),
    );
    controller.close();
    await reading;
    expect(early).toBe(true);
    expect(events.at(-1)?.type).toBe("response.completed");
  });

  it("emits an in-progress search item before the broker finishes", async () => {
    const brokerStarted = defer();
    const releaseBroker = defer();
    const continuationStarted = defer();
    const continuationDelta = defer();
    let continuationController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const gateway = Bun.serve({
      port: 0,
      async fetch(request) {
        if (new URL(request.url).pathname === "/openai/responses") {
          brokerStarted.resolve();
          await releaseBroker.promise;
          return Response.json({
            status: "completed",
            output: [
              { type: "web_search_call", action: { type: "search", query: "Mars" } },
              {
                type: "message",
                content: [{ type: "output_text", text: "Mars fact", annotations: [] }],
              },
            ],
            usage: { input_tokens: 2, output_tokens: 1 },
          });
        }
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              continuationController = controller;
              controller.enqueue(
                new TextEncoder().encode(
                  [
                    { type: "message_start", message: { usage: { input_tokens: 3 } } },
                    {
                      type: "content_block_start",
                      index: 0,
                      content_block: { type: "text", text: "" },
                    },
                    {
                      type: "content_block_delta",
                      index: 0,
                      delta: { type: "text_delta", text: "second-round" },
                    },
                  ]
                    .map(wire)
                    .join(""),
                ),
              );
              continuationStarted.resolve();
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    });
    try {
      process.env.BROKER_STREAM_TEST_KEY = "test-key";
      const brokerRoute = {
        ...search,
        upstream: new URL(`${gateway.url.origin}/openai`),
      };
      const upstream = sse([
        { type: "message_start", message: { usage: { input_tokens: 1 } } },
        {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "tool_use",
            id: "toolu_search",
            name: "web_search",
            input: { query: "Mars" },
          },
        },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 1 } },
        { type: "message_stop" },
      ]);
      const events: Json[] = [];
      const reading = (async () => {
        for await (const raw of brokeredAnthropicEvents(
          upstream,
          new URL(`${gateway.url.origin}/anthropic/v1/messages`),
          new Headers(),
          prepareAnthropic(payload, claude, key),
          claude.model.slug,
          context(brokerRoute),
        )) {
          const event = JSON.parse(raw) as Json;
          events.push(event);
          if (event.type === "response.output_text.delta" && event.delta === "second-round")
            continuationDelta.resolve();
        }
      })();
      await brokerStarted.promise;
      expect(
        events.some(
          (event) =>
            event.type === "response.output_item.added" &&
            (event.item as Json)?.type === "web_search_call" &&
            (event.item as Json)?.status === "in_progress",
        ),
      ).toBe(true);
      expect(
        events.some(
          (event) =>
            event.type === "response.output_item.done" &&
            (event.item as Json)?.type === "web_search_call",
        ),
      ).toBe(false);
      releaseBroker.resolve();
      await continuationStarted.promise;
      await continuationDelta.promise;
      expect(
        events.find(
          (event) => event.type === "response.output_text.delta" && event.delta === "second-round",
        )?.output_index,
      ).toBe(2);
      expect(events.some((event) => event.type === "response.completed")).toBe(false);
      continuationController!.enqueue(
        new TextEncoder().encode(
          [
            { type: "content_block_stop", index: 0 },
            {
              type: "message_delta",
              delta: { stop_reason: "end_turn" },
              usage: { output_tokens: 1 },
            },
            { type: "message_stop" },
          ]
            .map(wire)
            .join(""),
        ),
      );
      continuationController!.close();
      await reading;
      expect(events.at(-1)?.type).toBe("response.completed");
      expect(
        events.some(
          (event) =>
            event.type === "response.output_item.done" &&
            (event.item as Json)?.type === "web_search_call",
        ),
      ).toBe(true);
    } finally {
      releaseBroker.resolve();
      try {
        continuationController?.close();
      } catch {
        // The successful path already closed it.
      }
      await gateway.stop(true);
    }
  });
});
