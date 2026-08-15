import { describe, expect, it } from "vite-plus/test";

import { classifyHarness } from "./harness.ts";

describe("classifyHarness", () => {
  it("classifies Codex Desktop and records normalized versions", () => {
    const headers = new Headers({
      originator: "Codex Desktop",
      "user-agent":
        "Codex Desktop/0.148.0-alpha.9 (Mac OS 26.6.0; arm64) unknown (Codex Desktop; 26.810.41047)",
    });

    expect(classifyHarness(headers)).toEqual({
      kind: "desktop",
      version: "0.148.0-alpha.9",
      build: "26.810.41047",
    });
  });

  it("classifies Codex TUI", () => {
    const headers = new Headers({
      originator: "codex-tui",
      "user-agent":
        "codex-tui/0.146.0 (Mac OS 26.5.0; arm64) iTerm.app/3.6.10 (codex-tui; 0.146.0)",
    });

    expect(classifyHarness(headers)).toEqual({ kind: "tui", version: "0.146.0" });
  });

  it("reports conflicting originator and user agent instead of guessing", () => {
    const headers = new Headers({
      originator: "Codex Desktop",
      "user-agent": "codex-tui/0.146.0 (Mac OS 26.5.0; arm64)",
    });

    expect(classifyHarness(headers)).toEqual({ kind: "conflicted" });
  });
});
