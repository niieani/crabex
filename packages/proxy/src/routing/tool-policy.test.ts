import { describe, expect, it } from "vite-plus/test";

import { modelRouteFromConfig, parseModelRouteSet, type ModelRouteConfig } from "./model-routes.ts";
import { applyRouteToolPolicy } from "./tool-policy.ts";

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
