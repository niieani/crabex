// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import type { ModelRouteConfig, ToolPolicy } from "../../lib/types.ts";
import { RouteCapabilities } from "./RouteCapabilities.tsx";

const responsePolicy: ToolPolicy = {
  function: "pass",
  namespace: "pass",
  custom: "pass",
  web_search: "pass",
  tool_search: "pass",
  other: "pass",
};
const actions: NonNullable<ModelRouteConfig["tool_policy_actions"]> = {
  function: ["pass", "omit", "reject"],
  namespace: ["pass", "omit", "reject"],
  custom: ["pass", "omit", "reject"],
  web_search: ["pass", "omit", "reject"],
  tool_search: ["pass", "omit", "reject"],
  other: ["pass", "omit", "reject"],
};

function route(slug = "glm-5.3-flash"): ModelRouteConfig {
  return {
    api: "responses",
    authorization_env: "ROUTE_KEY",
    upstream: "https://gateway.example/v1",
    model: {
      slug,
      display_name: slug,
      description: "Example",
      template_slug: "gpt-5.6-luna",
      priority: 1,
    },
    effective_tool_policy: responsePolicy,
    tool_policy_actions: actions,
    search_broker_eligibility: { eligible: true },
  };
}

afterEach(cleanup);

describe("route capability controls", () => {
  it("migrates a legacy allowlist to equivalent explicit policy", () => {
    const onUpdate = vi.fn();
    const legacy = route();
    legacy.allowed_tool_types = ["function"];
    legacy.effective_tool_policy = {
      function: "pass",
      namespace: "omit",
      custom: "omit",
      web_search: "omit",
      tool_search: "omit",
      other: "omit",
    };
    render(
      <RouteCapabilities
        route={legacy}
        routes={[legacy]}
        defaultBroker="gpt-6-luna"
        pending={false}
        onUpdate={onUpdate}
      />,
    );
    fireEvent.click(screen.getByText("Tools, search, and agents"));
    expect(screen.getByText(/Legacy allowed_tool_types is active/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Convert allowlist to policy" }));
    expect(onUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ tool_policy: legacy.effective_tool_policy }),
    );
    expect(onUpdate.mock.calls[0]![0]).not.toHaveProperty("allowed_tool_types");
  });

  it("shows allowed actions and stores only the selected override", () => {
    const onUpdate = vi.fn();
    const configured = route();
    configured.tool_policy = { custom: "omit" };
    configured.effective_tool_policy = { ...responsePolicy, custom: "omit" };
    render(
      <RouteCapabilities
        route={configured}
        routes={[configured]}
        defaultBroker="gpt-6-luna"
        pending={false}
        onUpdate={onUpdate}
      />,
    );
    fireEvent.click(screen.getByText("Tools, search, and agents"));
    const custom = screen.getByRole("combobox", { name: "glm-5.3-flash Custom action" });
    expect((custom as HTMLSelectElement).value).toBe("omit");
    expect(screen.getByText("Effective: omit · override")).toBeTruthy();
    expect([...custom.querySelectorAll("option")].map((option) => option.value)).toEqual([
      "inherit",
      "pass",
      "omit",
      "reject",
    ]);
    fireEvent.change(custom, { target: { value: "reject" } });
    expect(onUpdate).toHaveBeenCalledWith({
      ...configured,
      tool_policy: { custom: "reject" },
    });
  });

  it("shows a missing broker and edits the Anthropic override and delegation catalog field", () => {
    const onUpdate = vi.fn();
    const claude = route("anthropic.claude-haiku-4-5");
    claude.api = "anthropic-messages";
    claude.search_broker_eligibility = {
      eligible: false,
      code: "api",
      reason: 'Search broker route "anthropic.claude-haiku-4-5" must use OpenAI Responses.',
    };
    claude.effective_tool_policy = { ...responsePolicy, web_search: "broker" };
    claude.tool_policy_actions = { ...actions, web_search: ["broker", "omit", "reject"] };
    claude.model.overrides = { context_window: 200000 };
    const broker = route("gpt-6-luna");
    render(
      <RouteCapabilities
        route={claude}
        routes={[claude, broker]}
        defaultBroker="missing-search"
        pending={false}
        onUpdate={onUpdate}
      />,
    );
    fireEvent.click(screen.getByText("Tools, search, and agents"));
    expect(screen.getByRole("alert").textContent).toContain('"missing-search" is missing');
    fireEvent.change(screen.getByLabelText("Search broker override"), {
      target: { value: "gpt-6-luna" },
    });
    expect(onUpdate).toHaveBeenCalledWith({ ...claude, search_broker: { route: "gpt-6-luna" } });
    fireEvent.change(screen.getByLabelText("Allow this model's children to delegate"), {
      target: { value: "disabled" },
    });
    expect(onUpdate).toHaveBeenCalledWith({
      ...claude,
      model: {
        ...claude.model,
        overrides: { context_window: 200000, multi_agent_version: "disabled" },
      },
    });
  });

  it("keeps a saved ineligible Anthropic override visible with its reason", () => {
    const claude = route("anthropic.claude-haiku-4-5");
    claude.api = "anthropic-messages";
    claude.effective_tool_policy = { ...responsePolicy, web_search: "broker" };
    claude.search_broker_eligibility = {
      eligible: false,
      code: "api",
      reason: 'Search broker route "anthropic.claude-haiku-4-5" must use OpenAI Responses.',
    };
    claude.search_broker = { route: "legacy-fireworks" };
    const legacy = route("legacy-fireworks");
    legacy.search_broker_eligibility = {
      eligible: false,
      code: "web_search",
      reason: 'Search broker route "legacy-fireworks" needs web_search: pass (effective: omit).',
    };
    const eligible = route("gpt-6-luna");
    render(
      <RouteCapabilities
        route={claude}
        routes={[claude, legacy, eligible]}
        defaultBroker="gpt-6-luna"
        pending={false}
        onUpdate={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText("Tools, search, and agents"));
    const select = screen.getByLabelText("Search broker override");
    expect((select as HTMLSelectElement).value).toBe("legacy-fireworks");
    expect([...select.querySelectorAll("option")].map((option) => option.value)).toEqual([
      "inherit",
      "legacy-fireworks",
      "gpt-6-luna",
    ]);
    expect(screen.getByRole("alert").textContent).toContain("effective: omit");
  });
});
