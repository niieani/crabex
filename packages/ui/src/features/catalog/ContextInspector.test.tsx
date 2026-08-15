// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import type { ContextSnapshot } from "../../lib/types.ts";
import { ContextInspector } from "./ContextInspector.tsx";

vi.mock("./ContextDiff.tsx", () => ({
  ContextDiff: ({ original, effective }: { original?: string; effective: string }) => (
    <div data-testid="context-diff">
      <pre data-testid="diff-original">{original}</pre>
      <pre data-testid="diff-effective">{effective}</pre>
    </div>
  ),
}));

afterEach(cleanup);

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
    const { container } = render(<ContextInspector snapshot={snapshot} />);

    expect(screen.getByRole("heading", { name: "user message" })).toBeTruthy();
    await waitFor(() => expect(diffText(container)).toContain("hi"));

    await user.click(screen.getByRole("button", { name: "Largest first" }));
    await user.click(screen.getByRole("button", { name: /functions\.exec/ }));

    expect(screen.getByRole("heading", { name: "functions.exec" })).toBeTruthy();
    await waitFor(() => expect(diffText(container)).toContain("large tool definition"));
  });

  it("shows function description and abbreviated JSON in separate tabs", async () => {
    const user = userEvent.setup();
    const functionSnapshot: ContextSnapshot = {
      ...snapshot,
      parts: [
        {
          ...snapshot.parts[1]!,
          description: "Wait for output.\nLong detail.",
          originalDescription: "Wait originally.\nOriginal detail.",
          json: '{\n  "description": "Wait for output.…"\n}',
          originalJson: '{\n  "description": "Wait originally.…"\n}',
          originalText: '{"description":"Wait originally.\\nOriginal detail."}',
        },
      ],
    };
    const { container } = render(<ContextInspector snapshot={functionSnapshot} />);

    await waitFor(() => expect(diffText(container)).toContain("Wait for output."));
    expect(originalDiffText(container)).toContain("Wait originally.");
    expect(originalDiffText(container)).not.toContain('{"description"');
    expect(diffText(container)).not.toContain("Wait for output.…");

    await user.click(screen.getByRole("button", { name: "JSON" }));
    await waitFor(() => expect(diffText(container)).toContain("Wait for output.…"));
    expect(originalDiffText(container)).toContain("Wait originally.…");
  });

  it("toggles classified parts and nested skills by identifier", async () => {
    const user = userEvent.setup();
    const onToggleIdentifier = vi.fn();
    const classified: ContextSnapshot = {
      ...snapshot,
      parts: [
        {
          ...snapshot.parts[0]!,
          name: "Skills instructions",
          identifier: "segment:skills",
          sections: [
            {
              identifier: "section:segment:skills/skills",
              label: "Skills",
              kind: "heading",
              text: "## Skills",
              characters: 9,
              estimatedTokens: 3,
              children: [
                {
                  identifier: "skill:imagegen",
                  label: "imagegen",
                  kind: "skill",
                  text: "- imagegen: Generate",
                  characters: 20,
                  estimatedTokens: 5,
                  children: [],
                },
              ],
            },
          ],
        },
      ],
    };
    render(<ContextInspector snapshot={classified} onToggleIdentifier={onToggleIdentifier} />);

    await user.click(screen.getByRole("switch", { name: "Disable Skills instructions" }));
    expect(onToggleIdentifier).toHaveBeenCalledWith("segment:skills", true);

    await user.click(screen.getByRole("button", { name: "Expand Skills" }));
    await user.click(screen.getByRole("switch", { name: "Disable imagegen" }));
    expect(onToggleIdentifier).toHaveBeenCalledWith("skill:imagegen", true);
  });

  it("searches Markdown across context parts", async () => {
    const user = userEvent.setup();
    render(<ContextInspector snapshot={snapshot} />);

    await user.type(screen.getByRole("searchbox", { name: "Search markdown" }), "hi");

    expect(screen.getByText("1 matching parts")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /functions\.exec/ })).toBeNull();
    expect(screen.getByRole("button", { name: /user message/ })).toBeTruthy();
  });

  it("keeps disabled parts and sections visible and re-enableable", async () => {
    const disabledPart = {
      ...snapshot.parts[0]!,
      id: "new-digest-id",
      name: "Plugins instructions",
      identifier: "segment:plugins",
      text: "",
      characters: 0,
      deleted: true,
      originalText: "<plugins_instructions>\n# Removed\ntext",
      sections: [
        {
          identifier: "section:segment:plugins/removed",
          label: "Removed",
          kind: "heading" as const,
          text: "",
          originalText: "# Removed\ntext",
          deleted: true,
          characters: 0,
          estimatedTokens: 0,
          children: [],
        },
      ],
    };

    render(
      <ContextInspector
        snapshot={{ ...snapshot, parts: [disabledPart] }}
        disabledIdentifiers={
          new Set([disabledPart.identifier, disabledPart.sections[0]!.identifier])
        }
      />,
    );

    expect(screen.getByRole("button", { name: /Plugins instructions/ })).toBeTruthy();
    expect(screen.getByRole("switch", { name: "Enable Plugins instructions" })).toBeTruthy();
    expect(screen.getByRole("switch", { name: "Enable Removed" })).toBeTruthy();
  });

  it("preserves expanded section state when preview content changes", async () => {
    const user = userEvent.setup();
    const classified = classifiedSnapshot("first-id", "## Skills\ntext");
    const { rerender } = render(<ContextInspector snapshot={classified} />);
    await user.click(screen.getByRole("button", { name: "Expand Skills" }));
    const details = screen
      .getByRole("button", { name: "Expand Skills" })
      .closest("details") as HTMLDetailsElement;
    expect(details.open).toBe(true);

    rerender(
      <ContextInspector snapshot={classifiedSnapshot("changed-id", "## Skills\nchanged")} />,
    );

    expect(
      (
        screen
          .getByRole("button", { name: "Expand Skills" })
          .closest("details") as HTMLDetailsElement
      ).open,
    ).toBe(true);
  });
});

function classifiedSnapshot(id: string, sectionText: string): ContextSnapshot {
  return {
    ...snapshot,
    parts: [
      {
        ...snapshot.parts[0]!,
        id,
        name: "Skills instructions",
        identifier: "segment:skills",
        sections: [
          {
            identifier: "section:segment:skills/skills",
            label: "Skills",
            kind: "heading",
            text: sectionText,
            characters: sectionText.length,
            estimatedTokens: Math.ceil(sectionText.length / 4),
            children: [
              {
                identifier: "skill:imagegen",
                label: "imagegen",
                kind: "skill",
                text: "- imagegen: Generate",
                characters: 20,
                estimatedTokens: 5,
                children: [],
              },
            ],
          },
        ],
      },
    ],
  };
}

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

function diffText(container: HTMLElement): string {
  return container.querySelector('[data-testid="diff-effective"]')?.textContent ?? "";
}

function originalDiffText(container: HTMLElement): string {
  return container.querySelector('[data-testid="diff-original"]')?.textContent ?? "";
}
