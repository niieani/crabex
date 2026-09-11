import { describe, expect, it } from "vite-plus/test";

import type { CaptureRequestSummary } from "./capture.ts";
import { CaptureRetention } from "./capture-retention.ts";

describe("capture retention", () => {
  it("keeps harness-only requests full and latches after a real user request", () => {
    const retention = new CaptureRetention();
    expect(retention.modeFor(summary(false))).toBe("full");
    expect(retention.modeFor(undefined)).toBe("full");
    expect(retention.modeFor(summary(true))).toBe("full");
    expect(retention.modeFor(undefined)).toBe("metadata");
  });

  it("latches per session so every conversation's first real prompt stays full", () => {
    const retention = new CaptureRetention();

    // Session A: warmup and first real prompt are full, later turns metadata.
    expect(retention.modeFor(summary(false), "thread-a")).toBe("full");
    expect(retention.modeFor(summary(true), "thread-a")).toBe("full");
    expect(retention.modeFor(summary(true), "thread-a")).toBe("metadata");
    expect(retention.modeFor(summary(false), "thread-a")).toBe("metadata");

    // Session B is unaffected by A's latch, including after the global latch
    // flipped: its warmup and first real prompt are still full.
    expect(retention.modeFor(summary(false), "thread-b")).toBe("full");
    expect(retention.modeFor(summary(true), "thread-b")).toBe("full");
    expect(retention.modeFor(summary(true), "thread-b")).toBe("metadata");
  });

  it("keeps unattributed events on the global latch once any real prompt lands", () => {
    const retention = new CaptureRetention();

    expect(retention.modeFor(undefined)).toBe("full");
    // A keyed real prompt flips the global latch too, collapsing response
    // streams and other unattributable events to metadata.
    expect(retention.modeFor(summary(true), "thread-a")).toBe("full");
    expect(retention.modeFor(undefined)).toBe("metadata");
    // But a fresh keyed session still gets its one full real prompt.
    expect(retention.modeFor(summary(true), "thread-b")).toBe("full");
  });
});

function summary(hasRealUserMessage: boolean): CaptureRequestSummary {
  return {
    type: "response.create",
    messages: [],
    hasRealUserMessage,
  };
}
