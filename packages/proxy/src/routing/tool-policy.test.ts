import { describe, expect, it } from "vite-plus/test";

import { modelRouteFromConfig, parseModelRouteSet, type ModelRouteConfig } from "./model-routes.ts";
import { allowedToolActions, applyRouteToolPolicy } from "./tool-policy.ts";

const base: ModelRouteConfig = {
  authorization_env: "TEST_KEY",
  model: {
    description: "Example route",
    display_name: "Example route",
    priority: 1,
    slug: "example-route",
    template_slug: "gpt-6-astra",
  },
  upstream: "https://gateway.example/v1",
};

describe("applyRouteToolPolicy", () => {
  it("offers only actions accepted for each API and transport", () => {
    expect(allowedToolActions("responses", "ws").custom).toEqual(["pass", "omit", "reject"]);
    expect(allowedToolActions("responses", "http").custom).toEqual([
      "pass",
      "translate",
      "omit",
      "reject",
    ]);
    expect(allowedToolActions("responses", "http").web_search).toEqual(["pass", "omit", "reject"]);
    expect(allowedToolActions("anthropic-messages", "http").web_search).toEqual([
      "broker",
      "omit",
      "reject",
    ]);
    expect(allowedToolActions("anthropic-messages", "http").other).toEqual(["omit", "reject"]);
  });
  it("accepts custom translation only on an HTTP Responses bridge", () => {
    const bridged = { ...base, transport: "http", tool_policy: { custom: "translate" } };
    expect(parseModelRouteSet([bridged]).routes[0]?.tool_policy).toEqual({ custom: "translate" });
    expect(() => parseModelRouteSet([{ ...bridged, transport: "ws" }])).toThrow(
      "requires http transport",
    );
    expect(() =>
      parseModelRouteSet([{ ...base, tool_policy: { web_search: "translate" } }]),
    ).toThrow("not implemented");
  });

  it("accepts tool search translation on HTTP Responses and Anthropic routes", () => {
    expect(
      parseModelRouteSet([
        { ...base, transport: "http", tool_policy: { tool_search: "translate" } },
      ]).routes[0]?.tool_policy,
    ).toEqual({ tool_search: "translate" });
    expect(() =>
      parseModelRouteSet([{ ...base, transport: "ws", tool_policy: { tool_search: "translate" } }]),
    ).toThrow('tool_policy.tool_search action "translate" requires http transport');
    expect(
      parseModelRouteSet([
        {
          ...base,
          api: "anthropic-messages",
          transport: "http",
          tool_policy: { tool_search: "translate" },
        },
      ]).routes[0]?.tool_policy,
    ).toEqual({ tool_search: "translate" });
  });

  it("allows a hosted web search broker only on Anthropic routes", () => {
    const config = {
      ...base,
      api: "anthropic-messages" as const,
      search_broker: { route: "search-route" },
      tool_policy: { web_search: "broker" },
    };
    const route = modelRouteFromConfig(parseModelRouteSet([config]).routes[0]!);
    expect(route.searchBrokerRoute).toBe("search-route");
    expect(route.toolPolicy.web_search).toBe("broker");
    expect(() => parseModelRouteSet([{ ...config, api: "responses" }])).toThrow(
      "search_broker requires an Anthropic route",
    );
    expect(() => parseModelRouteSet([{ ...base, tool_policy: { web_search: "broker" } }])).toThrow(
      "not implemented",
    );
    expect(() => parseModelRouteSet([{ ...config, search_broker: { route: "" } }])).toThrow(
      "search_broker.route",
    );
  });

  it("preserves legacy outbound tools and removes a typed choice for an omitted declaration", () => {
    const route = modelRouteFromConfig({ ...base, allowed_tool_types: ["function"] });
    const payload = {
      model: "example-route",
      tools: [
        { type: "function", name: "read" },
        { type: "namespace", name: "mcp", tools: [{ type: "function", name: "search" }] },
        { type: "web_search" },
        { type: "future_tool", name: "future" },
      ],
      tool_choice: { type: "web_search" },
    };

    const result = applyRouteToolPolicy(route, payload);

    expect(result.payload).toEqual({
      model: "example-route",
      tools: [{ type: "function", name: "read" }],
    });
    expect(result.omittedTypes).toEqual(["namespace", "web_search", "future_tool"]);
    expect(payload.tools).toHaveLength(4);
  });

  it("filters legacy allowlists by exact top-level type without emptying allowed namespaces", () => {
    const route = modelRouteFromConfig({
      ...base,
      allowed_tool_types: ["namespace", "future_tool"],
    });
    const namespace = {
      type: "namespace",
      name: "mcp",
      tools: [{ type: "function", name: "search" }],
    };
    const future = { type: "future_tool", name: "future" };
    const payload = {
      tools: [namespace, future, { type: "function", name: "read" }],
      tool_choice: { type: "function", namespace: "mcp", name: "search" },
    };

    expect(applyRouteToolPolicy(route, payload)).toEqual({
      payload: { tools: [namespace, future], tool_choice: payload.tool_choice },
      omittedTypes: ["function"],
    });
  });

  it("keeps function children when the legacy allowlist contains only namespace", () => {
    const route = modelRouteFromConfig({ ...base, allowed_tool_types: ["namespace"] });
    const namespace = {
      type: "namespace",
      name: "mcp",
      tools: [{ type: "function", name: "search" }],
    };
    const payload = { tools: [namespace] };
    expect(applyRouteToolPolicy(route, payload)).toEqual({ payload, omittedTypes: [] });
  });

  it("passes future declarations on a default Responses route", () => {
    const route = modelRouteFromConfig(base);
    const payload = {
      tools: [{ type: "future_tool", name: "future" }],
      tool_choice: { type: "future_tool" },
    };

    const result = applyRouteToolPolicy(route, payload);

    expect(result.payload).toBe(payload);
    expect(result.omittedTypes).toEqual([]);
  });

  it("passes native web search access flags and typed choice unchanged", () => {
    const route = modelRouteFromConfig({
      ...base,
      transport: "http",
      tool_policy: { web_search: "pass" },
    });
    for (const search of [
      { type: "web_search", external_web_access: true },
      { type: "web_search", external_web_access: false },
      { type: "web_search", external_web_access: true, indexed_web_access: true },
    ]) {
      const payload = { tools: [search], tool_choice: { type: "web_search" } };
      expect(applyRouteToolPolicy(route, payload)).toEqual({ payload, omittedTypes: [] });
    }
  });

  it("rejects future declarations for Anthropic unless other is omit", () => {
    const anthropic = { ...base, api: "anthropic-messages" as const };
    const payload = {
      tools: [{ type: "future_tool", name: "future" }],
      tool_choice: { type: "future_tool" },
    };
    expect(() => applyRouteToolPolicy(modelRouteFromConfig(anthropic), payload)).toThrow(
      'model route "example-route" rejects tool type "future_tool"',
    );

    const route = modelRouteFromConfig({ ...anthropic, tool_policy: { other: "omit" } });
    expect(applyRouteToolPolicy(route, payload)).toEqual({
      payload: { tools: [] },
      omittedTypes: ["future_tool"],
    });
  });

  it("omits nested declarations and a choice whose namespace was omitted", () => {
    const route = modelRouteFromConfig({
      ...base,
      tool_policy: { namespace: "omit", function: "omit" },
    });
    const payload = {
      tools: [
        { type: "namespace", name: "mcp", tools: [{ type: "function", name: "search" }] },
        { type: "function", name: "read" },
      ],
      tool_choice: { type: "function", namespace: "mcp", name: "search" },
    };

    expect(applyRouteToolPolicy(route, payload)).toEqual({
      payload: { tools: [] },
      omittedTypes: ["namespace", "function"],
    });
  });

  it("removes an empty namespace after omitting its children", () => {
    const route = modelRouteFromConfig({ ...base, tool_policy: { function: "omit" } });
    const payload = {
      tools: [{ type: "namespace", name: "mcp", tools: [{ type: "function", name: "search" }] }],
    };

    expect(applyRouteToolPolicy(route, payload)).toEqual({
      payload: { tools: [] },
      omittedTypes: ["function", "namespace"],
    });
  });

  it("removes a function choice when its containing namespace is omitted", () => {
    const route = modelRouteFromConfig({ ...base, tool_policy: { namespace: "omit" } });
    const payload = {
      tools: [
        { type: "namespace", name: "mcp", tools: [{ type: "function", name: "search" }] },
        { type: "function", name: "read" },
      ],
      tool_choice: { type: "function", namespace: "mcp", name: "search" },
    };

    expect(applyRouteToolPolicy(route, payload)).toEqual({
      payload: { tools: [{ type: "function", name: "read" }] },
      omittedTypes: ["namespace", "function"],
    });
  });
});
