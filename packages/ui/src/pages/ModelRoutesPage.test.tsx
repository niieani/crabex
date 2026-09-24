// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { putModelRoutes } from "../lib/api.ts";
import type { ModelRouteSet } from "../lib/types.ts";
import { ModelRoutesPage } from "./ModelRoutesPage.tsx";

vi.mock("../lib/api.ts", () => ({
  getModelRoutes: async () => ({
    version: 1,
    routes: ["Astra", "Sol", "Luna"].map((name, index) => ({
      authorization_env: "GATEWAY_KEY",
      upstream: "https://gateway.example/v1",
      model: {
        slug: name,
        template_slug: name,
        display_name: name,
        description: name,
        priority: index + 10,
      },
      targets: [{ upstream_model: name + "-flex", attempts: 3 }, { upstream_model: name }],
    })),
    adjustments: [{ slug: "other", overrides: { context_window: 123 } }],
    fixture_pins: ["other"],
  }),
  getModelRouteEnvStatus: async () => ({ GATEWAY_KEY: true }),
  getProxyConfig: async () => ({
    version: 1,
    appsAuthRelay: true,
    search_broker: { route: "gpt-6-luna" },
    routed_agents: { enabled: false },
  }),
  patchProxyConfig: vi.fn(),
  getRoutingTelemetry: async () => ({ telemetry: [], breakers: {} }),
  getUpstreamCache: async () => ({}),
  getModelsFixture: async () => ({ models: [] }),
  putModelRoutes: vi.fn(),
  resetStats: vi.fn(),
}));

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

function setup() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <ModelRoutesPage />
    </QueryClientProvider>,
  );
  return client;
}

describe("ModelRoutesPage ordering", () => {
  it("saves moves in both directions with matching priorities and preserves route settings", async () => {
    vi.mocked(putModelRoutes).mockImplementation(async (set) => set);
    const client = setup();
    await screen.findByRole("button", { name: "Move Astra up" });
    const before = client.getQueryData<ModelRouteSet>(["model-routes"])!;
    expect(
      (screen.getByRole("button", { name: "Move Astra up" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: "Move Luna down" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Move Sol up" }));
    await waitFor(() =>
      expect(screen.getAllByRole("heading", { level: 2 })[0]?.textContent).toBe("Sol"),
    );
    const saved = vi.mocked(putModelRoutes).mock.calls[0]![0];
    expect(saved.routes.map((r) => [r.model.slug, r.model.priority])).toEqual([
      ["Sol", 1],
      ["Astra", 2],
      ["Luna", 3],
    ]);
    expect(saved.adjustments).toEqual(before.adjustments);
    expect(saved.fixture_pins).toEqual(before.fixture_pins);
    for (const route of saved.routes) {
      const original = before.routes.find((r) => r.model.slug === route.model.slug)!;
      expect(route).toEqual({
        ...original,
        model: { ...original.model, priority: route.model.priority },
      });
    }
    fireEvent.click(screen.getByRole("button", { name: "Move Sol down" }));
    await waitFor(() =>
      expect(screen.getAllByRole("heading", { level: 2 })[0]?.textContent).toBe("Astra"),
    );
    expect(vi.mocked(putModelRoutes).mock.calls[1]![0].routes.map((r) => r.model.slug)).toEqual([
      "Astra",
      "Sol",
      "Luna",
    ]);
  });

  it("blocks moves while saving and keeps the original order when saving fails", async () => {
    let rejectSave: (error: Error) => void = () => {};
    vi.mocked(putModelRoutes).mockImplementation(
      () =>
        new Promise((_, reject) => {
          rejectSave = reject;
        }),
    );
    setup();
    fireEvent.click(await screen.findByRole("button", { name: "Move Sol up" }));
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "Move Luna up" }) as HTMLButtonElement).disabled,
      ).toBe(true),
    );
    fireEvent.click(screen.getByRole("button", { name: "Move Luna up" }));
    expect(putModelRoutes).toHaveBeenCalledTimes(1);
    rejectSave(new Error("Save failed"));
    await screen.findByText("Save failed");
    expect(screen.getAllByRole("heading", { level: 2 })[0]?.textContent).toBe("Astra");
    expect(
      (screen.getByRole("button", { name: "Move Sol up" }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });
});
