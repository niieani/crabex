import { describe, expect, it } from "vite-plus/test";

import type { CaptureEvent } from "./capture.ts";
import { NdjsonCaptureSink, type CaptureWriter } from "./ndjson-capture-sink.ts";

describe("NdjsonCaptureSink", () => {
  it("serializes concurrent writes in call order", async () => {
    const writes: string[] = [];
    const writer: CaptureWriter = {
      write: async (value) => {
        await Promise.resolve();
        writes.push(value);
      },
      close: async () => {},
    };
    const sink = new NdjsonCaptureSink(writer);

    await Promise.all([sink.record(event(1, "first")), sink.record(event(2, "second"))]);

    expect(writes).toEqual([
      `${JSON.stringify(event(1, "first"))}\n`,
      `${JSON.stringify(event(2, "second"))}\n`,
    ]);
  });

  it("keeps failing after its writer fails", async () => {
    let attempts = 0;
    const sink = new NdjsonCaptureSink({
      write: async () => {
        attempts += 1;
        throw new Error("disk full");
      },
      close: async () => {},
    });

    await expect(sink.record(event(1, "first"))).rejects.toThrow("disk full");
    await expect(sink.record(event(2, "second"))).rejects.toThrow("disk full");
    expect(attempts).toBe(1);
  });
});

function event(sequence: number, payload: string): CaptureEvent {
  return {
    sessionId: "session-1",
    sequence,
    timestamp: "2026-08-14T00:00:00.000Z",
    transport: "websocket",
    direction: "client_to_upstream",
    encoding: "utf8",
    payload,
  };
}
