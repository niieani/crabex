// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { TransformationsPage } from "./TransformationsPage.tsx";

vi.mock("../lib/api.ts", () => ({
  getTransformations: async () => ({
    version: 1,
    transformations: [
      {
        id: "multiline",
        name: "Multiline rule",
        enabled: true,
        scope: {},
        target: { field: "message_text" },
        operation: { type: "replace_all", find: "first line\nsecond line", replacement: "short" },
      },
    ],
  }),
  getTransformationTelemetry: async () => [],
  putTransformations: vi.fn(),
}));

afterEach(cleanup);

describe("TransformationsPage", () => {
  it("preserves newlines in the displayed find text", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { container } = render(
      <QueryClientProvider client={client}>
        <TransformationsPage />
      </QueryClientProvider>,
    );

    await screen.findByText("Multiline rule");
    const preview = container.querySelector("pre");

    expect(preview?.textContent).toBe("first line\nsecond line");
    expect(preview?.className).toContain("whitespace-pre-wrap");
    expect(preview?.className).not.toContain("truncate");
  });
});
