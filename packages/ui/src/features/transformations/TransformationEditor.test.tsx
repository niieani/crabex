// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { TransformationEditor } from "./TransformationEditor.tsx";
import type { ContextPart } from "../../lib/types.ts";

afterEach(cleanup);

describe("TransformationEditor", () => {
  it("creates a globally scoped literal replacement", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn();
    render(<TransformationEditor onCreate={onCreate} />);

    await user.type(screen.getByLabelText("Name"), "Smoke rewrite");
    await user.type(screen.getByLabelText("Find"), "original-smoke");
    await user.type(screen.getByLabelText("Replace with"), "transformed-smoke");
    await user.click(screen.getByRole("button", { name: "Add transformation" }));

    expect(onCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Smoke rewrite",
        enabled: true,
        scope: {},
        target: { field: "message_text" },
        operation: {
          type: "replace_all",
          find: "original-smoke",
          replacement: "transformed-smoke",
        },
      }),
    );
  });

  it("targets a classified part by identifier", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn();
    const selectedPart: ContextPart = {
      id: "skills",
      name: "Skills instructions",
      identifier: "segment:skills",
      text: "skills",
      characters: 6,
      estimatedTokens: 2,
      digest: "a".repeat(64),
      path: "input[0].content[0].text",
      phase: "inference",
      kind: "message",
    };
    render(<TransformationEditor onCreate={onCreate} selectedPart={selectedPart} />);

    await user.type(screen.getByLabelText("Name"), "Trim skills");
    await user.selectOptions(screen.getByLabelText("Operation"), "delete_part");
    await user.click(screen.getByRole("button", { name: "Add transformation" }));

    expect(onCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { field: "message_text", identifier: "segment:skills" },
      }),
    );
  });

  it("scopes a selected-text replacement to its stable Codex segment", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn();
    const selectedPart: ContextPart = {
      id: "plugins",
      name: "Plugins instructions",
      identifier: "segment:plugins",
      text: "shared text",
      characters: 11,
      estimatedTokens: 3,
      digest: "b".repeat(64),
      path: "input[0].content[0].text",
      phase: "inference",
      kind: "message",
    };
    render(
      <TransformationEditor onCreate={onCreate} selectedPart={selectedPart} initialFind="shared" />,
    );

    expect(screen.getByText("Scope")).toBeTruthy();
    expect(screen.queryByText("Scope and safety")).toBeNull();
    expect((screen.getByLabelText("Codex segment") as HTMLSelectElement).value).toBe(
      "segment:plugins",
    );
    await user.type(screen.getByLabelText("Name"), "Scoped plugin rewrite");
    await user.type(screen.getByLabelText("Replace with"), "short");
    await user.click(screen.getByRole("button", { name: "Add transformation" }));

    expect(onCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: { segments: ["segment:plugins"] },
        target: { field: "message_text" },
      }),
    );
  });
});
