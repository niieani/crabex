// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vite-plus/test";

import { patchProxyConfig } from "../../lib/api.ts";
import type { ModelRouteConfig, ProxyConfigState } from "../../lib/types.ts";
import { RouteProxySettings } from "./RouteProxySettings.tsx";

const state: ProxyConfigState = {
  path: "/tmp/proxy-config.json",
  version: 1,
  appsAuthRelay: true,
  allowAppsAuthRelay: true,
  search_broker: { route: "missing-search" },
  routed_agents: { enabled: false },
};

vi.mock("../../lib/api.ts", () => ({
  getProxyConfig: async () => state,
  patchProxyConfig: vi.fn(),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it("shows missing default broker and saves a Responses route selection and native-agent opt-in", async () => {
  const broker: ModelRouteConfig = {
    authorization_env: "BROKER_KEY",
    upstream: "https://gateway.example/v1",
    model: {
      slug: "gpt-6-luna",
      display_name: "Luna",
      description: "Search",
      template_slug: "gpt-6-luna",
      priority: 1,
    },
    effective_tool_policy: {
      function: "pass",
      namespace: "pass",
      custom: "pass",
      web_search: "pass",
      tool_search: "pass",
      other: "pass",
    },
  };
  const claude: ModelRouteConfig = {
    ...broker,
    api: "anthropic-messages",
    model: { ...broker.model, slug: "claude" },
  };
  vi.mocked(patchProxyConfig).mockImplementation(async (update) => ({ ...state, ...update }));
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <RouteProxySettings routes={[broker, claude]} envStatus={{ BROKER_KEY: true }} />
    </QueryClientProvider>,
  );
  expect((await screen.findByRole("alert")).textContent).toContain('"missing-search" is missing');
  const select = screen.getByLabelText("Default web search broker");
  expect([...select.querySelectorAll("option")].map((option) => option.value)).toEqual([
    "missing-search",
    "gpt-6-luna",
  ]);
  fireEvent.change(select, { target: { value: "gpt-6-luna" } });
  await waitFor(() =>
    expect(vi.mocked(patchProxyConfig).mock.calls[0]?.[0]).toEqual({
      search_broker: { route: "gpt-6-luna" },
    }),
  );
  await waitFor(() => expect(screen.queryByText(/is missing/)).toBeNull());
  fireEvent.click(screen.getByRole("switch", { name: "Native parents to routed agents" }));
  await waitFor(() =>
    expect(vi.mocked(patchProxyConfig).mock.calls[1]?.[0]).toEqual({
      routed_agents: { enabled: true },
    }),
  );
});
