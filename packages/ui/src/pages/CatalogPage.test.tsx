// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { CatalogPage } from "./CatalogPage.tsx";

const mocks = vi.hoisted(() => ({
  capture: undefined as string | undefined,
  navigate: vi.fn(),
  index: vi.fn(),
  detail: vi.fn(),
  preview: vi.fn(),
}));
vi.mock("@tanstack/react-router", () => ({
  useSearch: () => ({ capture: mocks.capture }),
  useNavigate: () => mocks.navigate,
}));
vi.mock("../lib/api.ts", () => ({
  getSnapshotIndex: mocks.index,
  getSnapshot: mocks.detail,
  previewSnapshot: mocks.preview,
  getTransformations: async () => ({ version: 1, transformations: [] }),
  putTransformations: vi.fn(),
}));
vi.mock("../features/catalog/ContextInspector.tsx", () => ({
  ContextInspector: ({ snapshot }: { snapshot: { model: string } }) => (
    <div>Inspecting {snapshot.model}</div>
  ),
  EmptyState: ({ title }: { title: string }) => <p>{title}</p>,
}));
afterEach(() => {
  cleanup();
  mocks.capture = undefined;
  vi.clearAllMocks();
});

function setup(detailOverrides: Record<string, unknown> = {}) {
  const summary = {
    id: "s:1",
    sessionId: "s",
    model: "sample-model",
    timestamp: "2026-09-22T00:00:00Z",
    harness: { kind: "desktop" },
    partCount: 100,
    characters: 10000,
    revision: "one",
  };
  mocks.index.mockResolvedValue([summary]);
  mocks.detail.mockResolvedValue({ ...summary, parts: [], ...detailOverrides });
  mocks.preview.mockResolvedValue({ ...summary, model: "preview-model", parts: [] });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <CatalogPage />
    </QueryClientProvider>,
  );
}

describe("capture browser", () => {
  it("loads summaries without loading full captures or previews, and filters the list", async () => {
    const user = userEvent.setup();
    setup();
    await screen.findByText("sample-model");
    expect(mocks.detail).not.toHaveBeenCalled();
    expect(mocks.preview).not.toHaveBeenCalled();
    await user.type(screen.getByRole("searchbox", { name: "Search captures" }), "missing");
    expect(await screen.findByText("No matching captures")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Clear filters" }));
    await user.click(screen.getByRole("button", { name: "Inspect sample-model s:1" }));
    expect(mocks.navigate).toHaveBeenCalledWith({ search: { capture: "s:1" } });
  });

  it("loads a bookmarked capture and previews rules only on request", async () => {
    const user = userEvent.setup();
    mocks.capture = "s:1";
    setup();
    let resolvePreview!: (value: unknown) => void;
    mocks.preview.mockReturnValue(
      new Promise((resolve) => {
        resolvePreview = resolve;
      }),
    );
    await screen.findByText("Inspecting sample-model");
    expect(mocks.preview).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Preview rules" }));
    await waitFor(() => expect(mocks.preview).toHaveBeenCalledWith("s:1", []));
    expect(screen.getByText("Inspecting sample-model")).toBeTruthy();
    resolvePreview({ id: "s:1", model: "preview-model", parts: [] });
    expect(await screen.findByText("Inspecting preview-model")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Captures" }));
    expect(mocks.navigate).toHaveBeenCalledWith({ search: { capture: undefined } });
  });

  it("shows omitted tool types from the selected capture", async () => {
    mocks.capture = "s:1";
    setup({
      routing: { action: "routed", omittedToolTypes: ["namespace", "web_search"] },
      errorSummary: { eventType: "error", status: 422, message: "Foreign history compaction" },
    });
    expect(await screen.findByText("Omitted tool types: namespace, web_search")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("Foreign history compaction");
  });
});
