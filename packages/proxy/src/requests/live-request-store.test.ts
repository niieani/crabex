import { describe, expect, it } from "vite-plus/test";

import { LiveRequestStore } from "./live-request-store.ts";

describe("LiveRequestStore", () => {
  it("accounts broker usage apart from the routed model request", () => {
    const store = new LiveRequestStore({ createId: () => "request-1" });
    const id = store.start({
      transport: "websocket",
      requestedModel: "claude-test",
      routeSlug: "claude-test",
      upstream: "https://gateway.example/anthropic/v1/messages",
    });
    store.recordBroker(id, "gpt-6-luna", {
      usage: { inputTokens: 10, outputTokens: 3 },
    });
    store.recordBroker(id, "gpt-6-luna", {
      usage: { inputTokens: 4, outputTokens: 0 },
      error: { code: "timeout" },
    });
    expect(store.snapshot().active[0]).toMatchObject({
      brokerUsage: {
        route: "gpt-6-luna",
        calls: 2,
        inputTokens: 14,
        outputTokens: 3,
        errors: 1,
      },
      detail: "Web search broker gpt-6-luna failed: timeout",
    });
  });

  it("tracks active lifecycle events and briefly retains completed requests", () => {
    let now = new Date("2026-09-17T12:00:00.000Z");
    const store = new LiveRequestStore({ now: () => now, createId: () => "request-1" });
    const id = store.start({
      transport: "http",
      requestedModel: "gpt-6-astra",
      routeSlug: "gpt-6-astra",
      upstream: "https://gateway.test/v1/responses",
      targetModel: "openai.gpt-6-astra-flex",
    });

    now = new Date("2026-09-17T12:00:01.000Z");
    store.update(id, { state: "retrying", attempt: 2, status: 429 });
    expect(store.snapshot().active[0]).toMatchObject({
      id,
      state: "retrying",
      attempt: 2,
      status: 429,
    });

    now = new Date("2026-09-17T12:00:02.000Z");
    store.finish(id, { state: "completed", status: 200 });
    expect(store.snapshot()).toMatchObject({ active: [], recent: [{ id, state: "completed" }] });

    now = new Date("2026-09-17T12:01:03.000Z");
    expect(store.snapshot()).toEqual({ active: [], recent: [] });
  });
});
