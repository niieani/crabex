// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vite-plus/test";

import { LiveRequestsPage } from "./LiveRequestsPage.tsx";

vi.mock("../lib/api.ts", () => ({
  getLiveRequests: async () => ({
    active: [],
    recent: [
      {
        id: "request-1",
        startedAt: "2026-09-23T00:00:00.000Z",
        updatedAt: "2026-09-23T00:00:01.000Z",
        completedAt: "2026-09-23T00:00:01.000Z",
        state: "failed",
        transport: "http",
        requestedModel: "anthropic.claude-haiku-4-5",
        routeSlug: "anthropic.claude-haiku-4-5",
        upstream: "https://gateway.example/v1",
        status: 422,
        detail: "Unreadable encrypted_content in agent_message; enable routed_agents",
        brokerUsage: {
          route: "gpt-6-luna",
          calls: 1,
          inputTokens: 120,
          outputTokens: 45,
          errors: 1,
        },
        events: [
          { at: "2026-09-23T00:00:00.000Z", state: "routing" },
          {
            at: "2026-09-23T00:00:00.500Z",
            state: "streaming",
            detail: "Omitted tool types: namespace, other",
          },
          { at: "2026-09-23T00:00:01.000Z", state: "failed", status: 422 },
        ],
      },
    ],
  }),
}));

afterEach(cleanup);

it("shows omitted tools, a refusal error, and broker usage in the live inspector", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <LiveRequestsPage />
    </QueryClientProvider>,
  );
  expect(await screen.findByText("Omitted tool types: namespace, other")).toBeTruthy();
  expect(screen.getByRole("alert").textContent).toContain("Unreadable encrypted_content");
  expect(screen.getByText(/Web search broker gpt-6-luna/).textContent).toContain("120 in / 45 out");
});
