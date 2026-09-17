import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vite-plus/test";

import type { CaptureEvent, CaptureRouting } from "../recording/capture.ts";
import { StatsStore } from "../recording/stats-store.ts";
import { EventRecorder } from "./event-recorder.ts";

describe("EventRecorder usage attribution", () => {
  it("records routing on the request and cache usage on response.completed", async () => {
    const stats = await StatsStore.open(
      join(await mkdtemp(join(tmpdir(), "act-er-")), "stats.json"),
    );
    const events: CaptureEvent[] = [];
    const recorder = new EventRecorder(
      { record: async (event) => void events.push(event) },
      () => new Date("2026-09-11T00:00:00.000Z"),
      () => "session",
      stats,
    );
    const routing: CaptureRouting = {
      action: "routed",
      routeSlugs: ["gpt-5.6-luna-flex"],
      upstreamModel: "openai.gpt-5.6-luna",
      attempts: [
        { upstreamModel: "openai.gpt-5.6-luna-flex", outcome: "failover", status: 429 },
        { upstreamModel: "openai.gpt-5.6-luna", outcome: "served", status: 200 },
      ],
    };

    await recorder.record("websocket", "client_to_upstream", '{"type":"response.create"}', "utf8", {
      routing,
    });
    await recorder.record(
      "websocket",
      "upstream_to_client",
      JSON.stringify({
        type: "response.completed",
        response: {
          usage: { input_tokens: 10_000, input_tokens_details: { cached_tokens: 0 } },
        },
      }),
      "utf8",
      { usageFor: routing },
    );

    const entry = stats.routingTelemetry().find((item) => item.routeSlug === "gpt-5.6-luna-flex");
    expect(entry).toMatchObject({
      count: 1,
      failovers: 1,
      fallbackCacheHitRate: 0,
      fallbackCache: { samples: 1, inputTokens: 10_000, cachedTokens: 0 },
    });
    expect(events).toHaveLength(2);
  });

  it("does not double-count routing when usageFor is attached to upstream events", async () => {
    const stats = await StatsStore.open(
      join(await mkdtemp(join(tmpdir(), "act-er-")), "stats.json"),
    );
    const recorder = new EventRecorder(
      { record: async () => {} },
      () => new Date("2026-09-11T00:00:00.000Z"),
      () => "session",
      stats,
    );
    const routing: CaptureRouting = {
      action: "routed",
      routeSlugs: ["kimi-k3"],
      attempts: [{ upstreamModel: "kimi-k3", outcome: "served", status: 200 }],
    };
    await recorder.record("websocket", "client_to_upstream", "{}", "utf8", { routing });
    await recorder.record(
      "websocket",
      "upstream_to_client",
      '{"type":"response.output_text.delta"}',
      "utf8",
      {
        usageFor: routing,
      },
    );
    expect(stats.routingTelemetry()[0]?.count).toBe(1);
  });

  it("keeps error diagnostics and origin after retention latches", async () => {
    const events: CaptureEvent[] = [];
    const recorder = new EventRecorder(
      { record: async (event) => void events.push(event) },
      () => new Date("2026-09-11T00:00:00.000Z"),
      () => "session",
    );

    await recorder.record(
      "websocket",
      "client_to_upstream",
      JSON.stringify({
        type: "response.create",
        input: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "hello" }],
          },
        ],
        client_metadata: { thread_id: "t-1" },
      }),
      "utf8",
    );
    await recorder.record(
      "websocket",
      "upstream_to_client",
      JSON.stringify({
        type: "error",
        status: 400,
        error: {
          message:
            "The 'gpt-5.6-sol' model is not supported when using Codex with a ChatGPT account.",
        },
      }),
      "utf8",
      {
        origin: {
          kind: "gateway-http",
          url: "https://gateway.example.test/openai/v1/responses",
        },
      },
    );

    expect(events[0]).toMatchObject({ payloadMode: "full" });
    expect(events[1]).toMatchObject({
      payloadMode: "metadata",
      eventType: "error",
      errorSummary: {
        eventType: "error",
        status: 400,
        message:
          "The 'gpt-5.6-sol' model is not supported when using Codex with a ChatGPT account.",
      },
      origin: {
        kind: "gateway-http",
        url: "https://gateway.example.test/openai/v1/responses",
      },
    });
    expect(events[1]).not.toHaveProperty("payload");
  });
});
