import { describe, expect, it } from "vite-plus/test";

import type { CaptureEvent } from "../recording/capture.ts";
import { buildSnapshots } from "./snapshot.ts";

describe("buildSnapshots", () => {
  it("reconstructs an inference snapshot from prewarm and linked request events", () => {
    const events: CaptureEvent[] = [
      event(1, "client_to_upstream", {
        type: "response.create",
        model: "gpt-5.6-luna",
        generate: false,
        input: [message("developer", "base instructions")],
      }),
      event(2, "upstream_to_client", {
        type: "response.completed",
        response: { id: "resp_warm", previous_response_id: null, usage: { input_tokens: 100 } },
      }),
      event(3, "client_to_upstream", {
        type: "response.create",
        model: "gpt-5.6-luna",
        previous_response_id: "resp_warm",
        input: [message("developer", "skills"), message("user", "hi")],
      }),
      event(4, "upstream_to_client", {
        type: "response.completed",
        response: {
          id: "resp_final",
          previous_response_id: "resp_warm",
          usage: { input_tokens: 180, input_tokens_details: { cached_tokens: 90 } },
        },
      }),
    ];

    const snapshots = buildSnapshots(events);

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({
      model: "gpt-5.6-luna",
      requestSequences: [1, 3],
      usage: { inputTokens: 180, cachedTokens: 90 },
    });
    expect(snapshots[0]?.parts.map((part) => part.text)).toEqual([
      "base instructions",
      "skills",
      "hi",
    ]);
    expect(snapshots[0]?.parts.every((part) => part.digest.length === 64)).toBe(true);
  });

  it("keeps original text beside transformed effective text", () => {
    const original = {
      type: "response.create",
      model: "gpt-5.6-luna",
      input: [message("user", "original")],
    };
    const transformed = {
      ...original,
      input: [message("user", "effective")],
    };
    const request = event(1, "client_to_upstream", original);
    request.effectivePayload = JSON.stringify(transformed);
    const snapshots = buildSnapshots([
      request,
      event(2, "upstream_to_client", {
        type: "response.completed",
        response: { id: "resp_1", usage: { input_tokens: 10 } },
      }),
    ]);

    expect(snapshots[0]?.parts[0]).toMatchObject({
      text: "effective",
      originalText: "original",
    });
  });
});

function event(
  sequence: number,
  direction: CaptureEvent["direction"],
  payload: unknown,
): CaptureEvent {
  return {
    sessionId: "session-1",
    sequence,
    timestamp: new Date(sequence * 1000).toISOString(),
    transport: "websocket",
    direction,
    encoding: "utf8",
    payload: JSON.stringify(payload),
    harness: { kind: "tui", version: "0.146.0" },
    project: "fixture",
  };
}

function message(role: string, text: string): unknown {
  return { type: "message", role, content: [{ type: "input_text", text }] };
}
