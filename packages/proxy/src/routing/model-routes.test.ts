import { describe, expect, it } from "vite-plus/test";

import {
  authorizationFor,
  inspectResponseModel,
  modelRouteFor,
  modelRouteFromConfig,
  parseModelRouteSet,
  responseTargetUrl,
  routedHeaders,
  RouteUnavailable,
} from "./model-routes.ts";

const routeConfig = [
  {
    authorization_env: "CLIPROXYAPI_KEY",
    model: {
      description: "Kimi K3 via CLIProxyAPI",
      display_name: "Kimi K3 via Fireworks",
      priority: 1,
      slug: "kimi-k3",
      template_slug: "gpt-5.4",
      overrides: {
        context_window: 1048576,
        multi_agent_version: null,
      } as Record<string, unknown>,
    },
    upstream: "http://127.0.0.1:8317/v1",
    upstream_model: "kimi-k3",
  },
];

describe("parseModelRouteSet", () => {
  it("parses a versioned route set", () => {
    expect(parseModelRouteSet({ version: 1, routes: routeConfig })).toEqual({
      routes: routeConfig,
      adjustments: [],
      fixture_pins: [],
    });
  });

  it("parses fixture pins from a versioned set", () => {
    const parsed = parseModelRouteSet({
      version: 1,
      routes: routeConfig,
      fixture_pins: ["gpt-6-astra"],
    });

    expect(parsed.fixture_pins).toEqual(["gpt-6-astra"]);
  });

  it("rejects malformed fixture pins", () => {
    expect(() => parseModelRouteSet({ version: 1, routes: [], fixture_pins: ["", 7] })).toThrow(
      "fixture_pins[0] must be a non-empty string",
    );
    expect(() => parseModelRouteSet({ version: 1, routes: [], fixture_pins: "gpt" })).toThrow(
      "model route set fixture_pins must be an array",
    );
  });

  it("parses model adjustments from a versioned set", () => {
    const parsed = parseModelRouteSet({
      version: 1,
      routes: routeConfig,
      adjustments: [
        {
          slug: "gpt-5.6-terra",
          overrides: { context_window: 1_000_000, model_messages: { token_budget: null } },
        },
      ],
    });

    expect(parsed.adjustments).toEqual([
      {
        slug: "gpt-5.6-terra",
        overrides: { context_window: 1_000_000, model_messages: { token_budget: null } },
      },
    ]);
  });

  it("rejects adjustments that rename the slug", () => {
    expect(() =>
      parseModelRouteSet({
        version: 1,
        routes: [],
        adjustments: [{ slug: "gpt-5.6-terra", overrides: { slug: "other" } }],
      }),
    ).toThrow("adjustment[0].overrides.slug is not allowed");
  });

  it("accepts a bare route array in the codex-enterprise file format", () => {
    expect(parseModelRouteSet(routeConfig)).toEqual({
      routes: routeConfig,
      adjustments: [],
      fixture_pins: [],
    });
  });

  it("rejects lifecycle metadata overrides", () => {
    const config = structuredClone(routeConfig);
    config[0].model.overrides = { upgrade: null };

    expect(() => parseModelRouteSet(config)).toThrow(
      "route[0].model.overrides.upgrade is not allowed",
    );
  });

  it("rejects a non-http upstream", () => {
    const config = structuredClone(routeConfig);
    config[0].upstream = "ftp://example.test/v1";

    expect(() => parseModelRouteSet(config)).toThrow("route[0].upstream must use http or https");
  });

  it("rejects a malformed set", () => {
    expect(() => parseModelRouteSet({ version: 2, routes: [] })).toThrow(
      "unsupported model route set",
    );
  });
});

describe("modelRouteFromConfig", () => {
  it("maps config to a runtime route, enabled by default", () => {
    const route = modelRouteFromConfig(parseModelRouteSet(routeConfig).routes[0]!);
    expect(route).toEqual({
      authorizationEnv: "CLIPROXYAPI_KEY",
      enabled: true,
      model: {
        description: "Kimi K3 via CLIProxyAPI",
        displayName: "Kimi K3 via Fireworks",
        overrides: {
          context_window: 1048576,
          multi_agent_version: null,
        },
        priority: 1,
        slug: "kimi-k3",
        templateSlug: "gpt-5.4",
      },
      upstream: new URL("http://127.0.0.1:8317/v1"),
      upstreamModel: "kimi-k3",
      targets: [{ upstreamModel: "kimi-k3", attempts: 1 }],
      retry: {
        onStatus: [429, 500, 502, 503, 504],
        backoffMs: [250, 1000],
        breaker: { failures: 3, cooldownMs: 60_000 },
      },
      transport: "ws",
    });
  });

  it("maps failover targets and retry policy", () => {
    const route = modelRouteFromConfig({
      authorization_env: "OPENAI_API_KEY",
      model: {
        description: "GPT-6 Astra via the AI gateway",
        display_name: "GPT-6 Astra",
        priority: 1,
        slug: "gpt-6-astra",
        template_slug: "gpt-6-astra",
      },
      upstream: "https://gateway.example.test/openai/v1",
      transport: "http",
      targets: [
        { upstream_model: "openai.gpt-6-astra-flex", attempts: 3 },
        { upstream_model: "openai.gpt-6-astra" },
      ],
      retry: { on_status: [429], backoff_ms: [500, 2000], breaker: { failures: 2 } },
    });

    expect(route.targets).toEqual([
      { upstreamModel: "openai.gpt-6-astra-flex", attempts: 3 },
      { upstreamModel: "openai.gpt-6-astra", attempts: 1 },
    ]);
    expect(route.retry).toEqual({
      onStatus: [429],
      backoffMs: [500, 2000],
      breaker: { failures: 2, cooldownMs: 60_000 },
    });
    expect(route.transport).toBe("http");
  });

  it("rejects routes setting both upstream_model and targets", () => {
    expect(() =>
      parseModelRouteSet({
        version: 1,
        routes: [
          {
            ...routeConfig[0],
            upstream_model: "kimi-k3",
            targets: [{ upstream_model: "kimi-k3" }],
          },
        ],
      }),
    ).toThrow("route[0] cannot set both upstream_model and targets");
  });

  it("rejects malformed targets and retry policies", () => {
    const { upstream_model: _upstreamModel, ...base } = routeConfig[0]!;
    expect(() =>
      parseModelRouteSet({
        version: 1,
        routes: [{ ...base, targets: [] }],
      }),
    ).toThrow("route[0].targets must be a non-empty array");
    expect(() =>
      parseModelRouteSet({
        version: 1,
        routes: [{ ...base, targets: [{ attempts: 0 }] }],
      }),
    ).toThrow("route[0].targets[0].attempts must be a positive integer");
    expect(() =>
      parseModelRouteSet({
        version: 1,
        routes: [{ ...base, retry: { on_status: [42] } }],
      }),
    ).toThrow("route[0].retry.on_status must be an array of HTTP status codes");
    expect(() =>
      parseModelRouteSet({
        version: 1,
        routes: [{ ...base, transport: "grpc" }],
      }),
    ).toThrow('route[0].transport must be "http" or "ws"');
  });
});

describe("authorizationFor", () => {
  const route = modelRouteFromConfig(parseModelRouteSet(routeConfig).routes[0]!);

  it("resolves the bearer token lazily from the environment", () => {
    expect(authorizationFor(route, { CLIPROXYAPI_KEY: "local-api-key" })).toBe(
      "Bearer local-api-key",
    );
  });

  it("fails when the declared credential is unavailable", () => {
    expect(() => authorizationFor(route, {})).toThrow(RouteUnavailable);
    expect(() => authorizationFor(route, {})).toThrow(
      "model route kimi-k3 requires unset authorization env: CLIPROXYAPI_KEY",
    );
  });
});

describe("modelRouteFor", () => {
  it("matches enabled routes by slug and skips disabled ones", () => {
    const route = modelRouteFromConfig(parseModelRouteSet(routeConfig).routes[0]!);
    expect(modelRouteFor([route], "kimi-k3")).toBe(route);
    expect(modelRouteFor([{ ...route, enabled: false }], "kimi-k3")).toBeUndefined();
    expect(modelRouteFor([route], "gpt-5.6")).toBeUndefined();
  });
});

describe("responseTargetUrl", () => {
  it("appends /responses to the upstream base path and preserves the query", () => {
    const route = modelRouteFromConfig(parseModelRouteSet(routeConfig).routes[0]!);
    expect(responseTargetUrl(route, "?trace=1").toString()).toBe(
      "http://127.0.0.1:8317/v1/responses?trace=1",
    );
  });
});

describe("routedHeaders", () => {
  it("swaps ChatGPT credentials for the route credential", () => {
    expect(
      routedHeaders(
        {
          authorization: "Bearer oauth-secret",
          "chatgpt-account-id": "workspace-123",
          cookie: "__cf_bm=affinity",
          "content-encoding": "gzip",
          "content-length": "42",
          "content-type": "application/json",
        },
        "Bearer local-api-key",
      ),
    ).toEqual({
      "content-type": "application/json",
      authorization: "Bearer local-api-key",
    });
  });
});

describe("inspectResponseModel", () => {
  it("extracts the model from a JSON payload", () => {
    expect(inspectResponseModel('{"model":"kimi-k3","input":[]}')).toEqual({
      payload: { model: "kimi-k3", input: [] },
      model: "kimi-k3",
    });
  });

  it("ignores non-JSON and model-less payloads", () => {
    expect(inspectResponseModel("not json")).toBeUndefined();
    expect(inspectResponseModel('{"type":"response.create"}')).toBeUndefined();
  });
});
