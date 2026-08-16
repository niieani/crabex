// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const { preloadHighlighter } = vi.hoisted(() => ({
  preloadHighlighter: vi.fn(() => Promise.resolve()),
}));

vi.mock("@pierre/diffs", () => ({ preloadHighlighter }));

vi.mock("@pierre/diffs/edit", () => ({
  Editor: class {
    setMarkers() {}
  },
}));

vi.mock("@pierre/diffs/react", () => ({
  EditProvider: ({ children }: { children: React.ReactNode }) => children,
  File: ({ editorOptions }: { editorOptions: { readOnly?: boolean } }) => (
    <div data-testid="pierre-file" data-read-only={String(editorOptions.readOnly)} />
  ),
  MultiFileDiff: ({ editorOptions }: { editorOptions: { readOnly?: boolean } }) => (
    <div data-testid="pierre-diff" data-read-only={String(editorOptions.readOnly)} />
  ),
}));

import { ContextDiff } from "./ContextDiff.tsx";

afterEach(cleanup);

describe("ContextDiff read-only mode", () => {
  it.each([
    [undefined, "pierre-file"],
    ["original", "pierre-diff"],
  ])("keeps the %s viewer selectable without making it editable", async (original, testId) => {
    await act(() =>
      render(
        <ContextDiff
          original={original}
          effective="effective"
          filename="context.md"
          search=""
          onTransformSelection={() => {}}
        />,
      ),
    );

    expect((await screen.findByTestId(testId)).getAttribute("data-read-only")).toBe("true");
  });

  it("loads JavaScript-family grammars before rendering Markdown", async () => {
    await act(() =>
      render(
        <ContextDiff
          effective={"```ts\nconst answer: number = 42\n```"}
          filename="context.md"
          search=""
          onTransformSelection={() => {}}
        />,
      ),
    );

    await waitFor(() =>
      expect(preloadHighlighter).toHaveBeenCalledWith({
        langs: ["markdown", "javascript", "typescript", "jsx", "tsx"],
        themes: ["pierre-dark"],
      }),
    );
    expect(await screen.findByTestId("pierre-file")).toBeDefined();
  });
});
