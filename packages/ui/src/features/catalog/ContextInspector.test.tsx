// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vite-plus/test";

import type { ContextSnapshot } from "../../lib/types.ts";
import { ContextInspector } from "./ContextInspector.tsx";

const snapshot: ContextSnapshot = {
  id: "session:3",
  sessionId: "session",
  timestamp: "2026-08-15T00:00:00.000Z",
  model: "gpt-5.6-luna",
  harness: { kind: "tui", version: "0.146.0" },
  project: "fixture",
  requestSequences: [1, 3],
  usage: { inputTokens: 17938, cachedTokens: 8960 },
  parts: [
    part("small", "user message", "hi", 2, "inference"),
    part("large", "functions.exec", "large tool definition", 22000, "prewarm", "tool"),
  ],
};

describe("ContextInspector", () => {
  it("puts captured content front and center and can sort by size", async () => {
    const user = userEvent.setup();
    render(<ContextInspector snapshot={snapshot} />);

    expect(screen.getByRole("heading", { name: "user message" })).toBeTruthy();
    expect(screen.getByText("hi")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Largest first" }));
    await user.click(screen.getByRole("button", { name: /functions\.exec/ }));

    expect(screen.getByRole("heading", { name: "functions.exec" })).toBeTruthy();
    expect(screen.getByText("large tool definition")).toBeTruthy();
  });
});

function part(
  id: string,
  name: string,
  text: string,
  characters: number,
  phase: "prewarm" | "inference",
  kind: "message" | "tool" = "message",
): ContextSnapshot["parts"][number] {
  return {
    id,
    name,
    text,
    characters,
    estimatedTokens: Math.ceil(characters / 4),
    digest: id.repeat(64).slice(0, 64),
    path: `input[0].${id}`,
    phase,
    kind,
  };
}
