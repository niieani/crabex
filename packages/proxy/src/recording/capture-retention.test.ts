import { describe, expect, it } from "vite-plus/test";

import { CaptureRetention } from "./capture-retention.ts";
import type { CaptureRequestSummary } from "./capture.ts";

describe("capture retention", () => {
  it("keeps harness-only requests full and latches after a real user request", () => {
    const retention = new CaptureRetention();
    expect(retention.modeFor(summary(false))).toBe("full");
    expect(retention.modeFor(undefined)).toBe("full");
    expect(retention.modeFor(summary(true))).toBe("full");
    expect(retention.modeFor(undefined)).toBe("metadata");
  });
});

function summary(hasRealUserMessage: boolean): CaptureRequestSummary {
  return {
    type: "response.create",
    messages: [],
    hasRealUserMessage,
  };
}
