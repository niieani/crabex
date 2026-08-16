// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

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
  ])("keeps the %s viewer selectable without making it editable", (original, testId) => {
    render(
      <ContextDiff
        original={original}
        effective="effective"
        filename="context.md"
        search=""
        onTransformSelection={() => {}}
      />,
    );

    expect(screen.getByTestId(testId).getAttribute("data-read-only")).toBe("true");
  });
});
