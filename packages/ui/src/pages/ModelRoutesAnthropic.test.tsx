// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { putModelRoutes } from "../lib/api.ts";
import { ModelRoutesPage } from "./ModelRoutesPage.tsx";
vi.mock("../lib/api.ts", () => ({
  getModelRoutes: async () => ({ version: 1, routes: [], adjustments: [], fixture_pins: [] }),
  getModelRouteEnvStatus: async () => ({}),
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
  putModelRoutes: vi.fn(async (set) => set),
  resetStats: vi.fn(),
}));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
it("creates an Anthropic route with HTTP and selected thinking/output limits", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ModelRoutesPage />
    </QueryClientProvider>,
  );
  await screen.findByRole("button", { name: "Add route" });
  fireEvent.change(screen.getByLabelText("Upstream API"), {
    target: { value: "anthropic-messages" },
  });
  for (const [label, value] of Object.entries({
    Slug: "claude",
    "Template slug": "gpt-6-astra",
    "Display name": "Claude",
    Description: "Claude route",
    "Authorization env": "TOKEN",
    "Upstream base URL": "https://gateway.example/anthropic",
    "Upstream model": "anthropic.claude-sonnet-5",
    "Maximum output tokens": "64000",
    Thinking: "adaptive",
  })) {
    fireEvent.change(screen.getByLabelText(label), { target: { value } });
  }
  fireEvent.click(screen.getByRole("button", { name: "Add route" }));
  await waitFor(() => expect(putModelRoutes).toHaveBeenCalled());
  expect(vi.mocked(putModelRoutes).mock.calls[0]![0].routes[0]).toMatchObject({
    api: "anthropic-messages",
    transport: "http",
    anthropic: { thinking: "adaptive", max_tokens: 64000 },
    upstream_model: "anthropic.claude-sonnet-5",
  });
});
