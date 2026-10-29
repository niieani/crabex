// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { ConfigBundlePage } from "./ConfigBundlePage.tsx";
import { putConfigBundle } from "../lib/api.ts";

const original = {
  version: 1 as const,
  enabled: true,
  mode: "replace" as const,
  bundle: {
    unknown: { retained: true },
    config_toml: {
      sectionExtra: 7,
      enterprise_managed: [
        { id: "policy", name: "Policy", contents: "enabled = true", fragmentExtra: 1 },
      ],
    },
    requirements_toml: null,
  },
};
vi.mock("../lib/api.ts", () => ({
  getConfigBundle: async () => structuredClone(original),
  getUpstreamCache: async () => ({
    configBundle: {
      fetchedAt: "2026-01-01T00:00:00Z",
      body: {
        config_toml: {
          managed_layers: {
            baseline: [{ id: "baseline", name: "Baseline", contents: "baseline = true" }],
            system_overlay: [{ id: "overlay", name: "Overlay", contents: "overlay = true" }],
          },
        },
        requirements_toml: {
          managed_layers: {
            baseline: [{ id: "requirements", name: "Requirements", contents: "allowed = true" }],
          },
        },
      },
    },
  }),
  getEffectiveConfigBundle: async () => ({
    enabled: true,
    mode: "replace",
    bundle: original.bundle,
    upstreamObservedAt: null,
  }),
  getRoutingTelemetry: async () => ({ telemetry: [] }),
  putConfigBundle: vi.fn(async (override) => override),
  deleteConfigBundle: vi.fn(),
}));
afterEach(cleanup);
beforeEach(() => vi.clearAllMocks());
async function setup() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <ConfigBundlePage />
    </QueryClientProvider>,
  );
  await screen.findByLabelText("config_toml fragment 1 id");
}
function editToml(contents: string) {
  const content = screen.getByLabelText("config_toml fragment 1 TOML");
  const view = EditorView.findFromDOM(content);
  if (!view) throw new Error("missing CodeMirror view");
  act(() => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: contents } }));
}
describe("ConfigBundlePage", () => {
  it("edits TOML and mode, preserving unknown fields and null sections", async () => {
    await setup();
    editToml('[mcp_servers.example]\nurl = "https://example.com/mcp"\n');
    fireEvent.click(screen.getByText("Merge into upstream"));
    fireEvent.click(screen.getByText("Save override"));
    await waitFor(() => expect(putConfigBundle).toHaveBeenCalled());
    expect(vi.mocked(putConfigBundle).mock.calls[0]?.[0]).toEqual({
      ...original,
      mode: "merge",
      bundle: {
        ...original.bundle,
        config_toml: {
          ...original.bundle.config_toml,
          enterprise_managed: [
            {
              ...original.bundle.config_toml.enterprise_managed[0],
              contents: '[mcp_servers.example]\nurl = "https://example.com/mcp"\n',
            },
          ],
        },
      },
    });
  });
  it("disables saving on TOML errors, empty ids and duplicate ids", async () => {
    await setup();
    editToml("invalid = [");
    expect((screen.getByText("Save override") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("alert").textContent).toContain("policy");
    editToml("enabled = true");
    fireEvent.change(screen.getByLabelText("config_toml fragment 1 id"), { target: { value: "" } });
    expect((screen.getByText("Save override") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("config_toml fragment 1 id"), {
      target: { value: "policy" },
    });
    fireEvent.click(screen.getByText("Add config.toml fragment"));
    fireEvent.change(screen.getByLabelText("config_toml fragment 2 id"), {
      target: { value: "policy" },
    });
    expect((screen.getByText("Save override") as HTMLButtonElement).disabled).toBe(true);
  });
  it("round trips raw JSON and reports errors when returning to fragments", async () => {
    await setup();
    fireEvent.click(screen.getByText("Raw JSON"));
    const input = screen.getByLabelText("Bundle JSON");
    fireEvent.change(input, { target: { value: "{" } });
    fireEvent.click(screen.getByText("Fragments"));
    expect(screen.getByRole("alert")).toBeTruthy();
    const next = structuredClone(original.bundle);
    next.config_toml.enterprise_managed[0]!.contents = "answer = 42";
    fireEvent.change(input, { target: { value: JSON.stringify(next) } });
    fireEvent.click(screen.getByText("Fragments"));
    expect(screen.getByLabelText("config_toml fragment 1 TOML").textContent).toBe("answer = 42");
    fireEvent.click(screen.getByText("Save override"));
    await waitFor(() => expect(putConfigBundle).toHaveBeenCalled());
    expect(vi.mocked(putConfigBundle).mock.calls[0]?.[0].bundle).toEqual(next);
  });
});

it("shows labelled managed layers read-only", async () => {
  await setup();
  expect(screen.getAllByText("managed_layers.baseline")).toHaveLength(2);
  expect(
    screen
      .getByLabelText("config_toml managed_layers.baseline observed 1 TOML")
      .getAttribute("contenteditable"),
  ).toBe("false");
  expect(
    screen.getByLabelText("config_toml managed_layers.system_overlay observed 1 TOML").textContent,
  ).toBe("overlay = true");
});
