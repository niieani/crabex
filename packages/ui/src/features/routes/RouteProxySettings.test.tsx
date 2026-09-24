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
  search_broker_eligibility: { eligible: true },
};

vi.mock("../../lib/api.ts", () => ({
  getProxyConfig: async () => state,
  patchProxyConfig: vi.fn(),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  state.search_broker.route = "missing-search";
});

it("shows missing default broker and saves a Responses route selection and native-agent opt-in", async () => {
  const claude: ModelRouteConfig = {
    ...broker,
    api: "anthropic-messages",
    model: { ...broker.model, slug: "claude" },
    search_broker_eligibility: {
      eligible: false,
      code: "api",
      reason: 'Search broker route "claude" must use OpenAI Responses.',
    },
  };
  vi.mocked(patchProxyConfig).mockImplementation(async (update) => ({ ...state, ...update }));
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <RouteProxySettings routes={[broker, claude]} />
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
  fireEvent.change(screen.getByLabelText("Routed agent instructions"), {
    target: { value: "Use these routes for narrow reviews" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save instructions" }));
  await waitFor(() =>
    expect(vi.mocked(patchProxyConfig).mock.calls[2]?.[0]).toEqual({
      routed_agents: { enabled: true, instructions: "Use these routes for narrow reviews" },
    }),
  );
});

it("keeps a saved ineligible default visible and offers only eligible routes", async () => {
  state.search_broker.route = "legacy-fireworks";
  const legacy: ModelRouteConfig = {
    ...broker,
    model: { ...broker.model, slug: "legacy-fireworks" },
    effective_tool_policy: { ...broker.effective_tool_policy!, web_search: "omit" },
    search_broker_eligibility: {
      eligible: false,
      code: "web_search",
      reason: 'Search broker route "legacy-fireworks" needs web_search: pass (effective: omit).',
    },
  };
  const disabled: ModelRouteConfig = {
    ...broker,
    model: { ...broker.model, slug: "disabled" },
    enabled: false,
    search_broker_eligibility: {
      eligible: false,
      code: "disabled",
      reason: 'Search broker route "disabled" is disabled.',
    },
  };
  const unauthorized: ModelRouteConfig = {
    ...broker,
    model: { ...broker.model, slug: "unauthorized" },
    search_broker_eligibility: {
      eligible: false,
      code: "authorization",
      reason: 'Search broker route "unauthorized" has no usable authorization.',
    },
  };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <RouteProxySettings routes={[legacy, disabled, unauthorized, broker]} />
    </QueryClientProvider>,
  );
  const select = await screen.findByLabelText("Default web search broker");
  expect((select as HTMLSelectElement).value).toBe("legacy-fireworks");
  expect([...select.querySelectorAll("option")].map((option) => option.value)).toEqual([
    "legacy-fireworks",
    "gpt-6-luna",
  ]);
  expect(screen.getByRole("alert").textContent).toContain("effective: omit");
});
