import { describe, expect, it } from "vite-plus/test";

import {
  httpPayloadFor,
  parseSseEvents,
  rewriteBridgedEvent,
  warmupCompletionEvents,
  wrappedErrorEvent,
} from "./responses-bridge.ts";

describe("warmupCompletionEvents", () => {
  it("answers a generate:false create with a local created/completed pair", () => {
    const [created, completed] = warmupCompletionEvents("gpt-6-astra").map(
      (event) => JSON.parse(event) as { type: string; response: Record<string, unknown> },
    );

    expect(created?.type).toBe("response.created");
    expect(created?.response).toMatchObject({
      id: "",
      model: "gpt-6-astra",
      output: [],
      status: "in_progress",
    });
    expect(completed?.type).toBe("response.completed");
    expect(completed?.response).toMatchObject({
      id: "",
      model: "gpt-6-astra",
      output: [],
      status: "completed",
    });
  });
});

describe("httpPayloadFor", () => {
  it("strips WebSocket-only envelope fields", () => {
    expect(
      httpPayloadFor({
        type: "response.create",
        client_metadata: { session_id: "s" },
        generate: false,
        model: "gpt-6-astra",
        input: [],
        stream: false,
      }),
    ).toEqual({ model: "gpt-6-astra", input: [], stream: false });
  });
});

describe("rewriteBridgedEvent", () => {
  it("rewrites response.model and blanks response.id in streamed events", () => {
    const event = JSON.stringify({
      type: "response.completed",
      response: { id: "resp_1", model: "openai.gpt-6-astra-flex", status: "completed" },
    });

    const rewritten = JSON.parse(rewriteBridgedEvent(event, "gpt-6-astra")) as {
      response: { id: string; model: string };
    };
    expect(rewritten.response.model).toBe("gpt-6-astra");
    // Empty id stops Codex from chaining via previous_response_id, which ZDR
    // upstreams reject; it replays the full input on the next create instead.
    expect(rewritten.response.id).toBe("");
  });

  it("leaves events without a response object and non-JSON data untouched", () => {
    const delta = JSON.stringify({ type: "response.output_text.delta", delta: "hi" });
    expect(rewriteBridgedEvent(delta, "gpt-6-astra")).toBe(delta);
    expect(rewriteBridgedEvent("not json", "gpt-6-astra")).toBe("not json");
  });
});

describe("wrappedErrorEvent", () => {
  it("maps an upstream JSON error body onto the wrapped error shape", () => {
    const event = JSON.parse(
      wrappedErrorEvent(
        429,
        JSON.stringify({ error: { code: "resource_unavailable", message: "no flex capacity" } }),
      ),
    ) as { type: string; status: number; error: { code: string; message: string } };

    expect(event).toEqual({
      type: "error",
      status: 429,
      error: { code: "resource_unavailable", message: "no flex capacity" },
    });
  });

  it("falls back to the raw body for non-JSON errors", () => {
    const event = JSON.parse(wrappedErrorEvent(502, "bad gateway")) as {
      type: string;
      status: number;
      error: { code: string; message: string };
    };

    expect(event).toEqual({
      type: "error",
      status: 502,
      error: { code: "http_502", message: "bad gateway" },
    });
  });
});

describe("parseSseEvents", () => {
  function streamOf(...chunks: string[]): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    return new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    });
  }

  async function collect(body: ReadableStream<Uint8Array>): Promise<string[]> {
    const events: string[] = [];
    for await (const event of parseSseEvents(body)) events.push(event);
    return events;
  }

  it("parses events across chunk boundaries and skips comments and event lines", async () => {
    const body = streamOf(
      ": preamble\n\nevent: response.created\nda",
      'ta: {"type":"response.created"}\n\nevent: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"hi"}\r\n\r\nevent: response.completed\ndata: {"type":"response.completed"}\n\n',
    );

    expect(await collect(body)).toEqual([
      '{"type":"response.created"}',
      '{"type":"response.output_text.delta","delta":"hi"}',
      '{"type":"response.completed"}',
    ]);
  });

  it("joins multi-line data and skips the [DONE] sentinel", async () => {
    const body = streamOf('data: {"a":\ndata: 1}\n\ndata: [DONE]\n\n');

    expect(await collect(body)).toEqual(['{"a":\n1}']);
  });

  it("flushes a trailing event without a terminating blank line", async () => {
    const body = streamOf('data: {"type":"response.completed"}');

    expect(await collect(body)).toEqual(['{"type":"response.completed"}']);
  });
});
