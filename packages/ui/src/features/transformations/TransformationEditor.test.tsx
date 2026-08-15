// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vite-plus/test";

import { TransformationEditor } from "./TransformationEditor.tsx";

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
});
