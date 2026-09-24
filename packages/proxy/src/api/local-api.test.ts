import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vite-plus/test";

import type { ConfigBundleOverride } from "../config/config-bundle-store.ts";
import type { CodexConfigState } from "../config/codex-config.ts";
import type { ContextSnapshot } from "../context/snapshot.ts";
import type { TransformationSet } from "../context/transformation.ts";
import type { ModelRouteConfig, ModelRouteSetData } from "../routing/model-routes.ts";
import { StatsStore } from "../recording/stats-store.ts";
import { createLocalApi } from "./local-api.ts";
import { openProxyConfigStore } from "../config/proxy-config-store.ts";

const routeConfigs: ModelRouteConfig[] = [
  {
    authorization_env: "ACT_TEST_ROUTE_KEY",
    model: {
      description: "Kimi K3 via CLIProxyAPI",
      display_name: "Kimi K3",
      priority: 1,
      slug: "kimi-k3",
      template_slug: "gpt-5.6-terra",
    },
    upstream: "http://127.0.0.1:8317/v1",
  },
];

function stubSources(overrides: {
  routes?: ModelRouteConfig[];
  onReplaceRoutes?: (routes: ModelRouteConfig[]) => void;
  bundle?: ConfigBundleOverride;
  onReplaceBundle?: (override: ConfigBundleOverride) => void;
}) {
  let routes = overrides.routes ?? [];
  let bundle = overrides.bundle ?? { version: 1 as const, enabled: false, bundle: null };
  return {
    modelRoutes: {
      get: () => ({ routes, adjustments: [], fixture_pins: [] }),
      replace: async (next: ModelRouteSetData) => {
        routes = next.routes;
        overrides.onReplaceRoutes?.(next.routes);
      },
    },
    configBundle: {
      get: () => bundle,
      replace: async (next: ConfigBundleOverride) => {
        bundle = next;
        overrides.onReplaceBundle?.(next);
      },
    },
    currentRoutes: () => routes,
    currentBundle: () => bundle,
    codexConfig: stubCodexConfig(),
    upstreamCache: stubUpstreamCache(),
  };
}

function stubUpstreamCache() {
  return {
    get: () => ({}),
    observe: async () => {},
  };
}

function stubCodexConfig(state?: Partial<CodexConfigState>) {
  return {
    state: async (): Promise<CodexConfigState> => ({
      path: "/tmp/act-test/config.toml",
      exists: true,
      toggles: [],
      ...state,
    }),
    setEnabled: async (_key: string, _enabled: boolean): Promise<CodexConfigState> => ({
      path: "/tmp/act-test/config.toml",
      exists: true,
      toggles: [],
      ...state,
    }),
  };
}

describe("local context API", () => {
  it("reports TLS status without exposing certificate mutation endpoints", async () => {
    const api = createLocalApi({
      snapshots: { list: async () => [], preview: async () => undefined },
      transformations: {
        get: () => ({ version: 1 as const, transformations: [] }),
        replace: async () => {},
      },
      ...stubSources({}),
      tlsStatus: async () => ({
        enabled: true,
        trusted: true,
        renewalDue: false,
        expiresAt: "2027-09-18T00:00:00.000Z",
      }),
    });
    const url = "http://localhost/__agent-context-trimmer/api/tls-status";
    expect(await (await api.handle(new Request(url)))?.json()).toEqual({
      enabled: true,
      trusted: true,
      renewalDue: false,
      expiresAt: "2027-09-18T00:00:00.000Z",
    });
    expect((await api.handle(new Request(url, { method: "POST" })))?.status).toBe(405);
  });

  it("exposes and persists the default-on relay setting while rejecting invalid updates", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "act-api-config-")), "config.json");
    const proxyConfig = await openProxyConfigStore(path);
    const options = {
      snapshots: { list: async () => [], preview: async () => undefined },
      transformations: {
        get: () => ({ version: 1 as const, transformations: [] }),
        replace: async () => {},
      },
      ...stubSources({}),
      proxyConfig,
    };
    const api = createLocalApi(options);
    const url = "http://localhost/__agent-context-trimmer/api/proxy-config";
    expect(await (await api.handle(new Request(url)))?.json()).toMatchObject({
      path,
      appsAuthRelay: true,
      search_broker: { route: "gpt-6-luna" },
    });
    const update = (value: unknown) =>
      new Request(url, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(value),
      });
    expect((await api.handle(update({ version: 1, appsAuthRelay: false })))?.status).toBe(200);
    expect((await openProxyConfigStore(path)).get().appsAuthRelay).toBe(false);
    expect(
      (await api.handle(update({ version: 1, search_broker: { route: "search-route" } })))?.status,
    ).toBe(200);
    expect(proxyConfig.get().search_broker.route).toBe("search-route");
    expect((await api.handle(update({ version: 1, appsAuthRelay: false })))?.status).toBe(200);
    expect(proxyConfig.get().search_broker.route).toBe("search-route");
    expect((await api.handle(update({ version: 1, search_broker: { route: "" } })))?.status).toBe(
      400,
    );
    expect((await api.handle(update({ version: 1, appsAuthRelay: "false" })))?.status).toBe(400);
    expect(
      (
        await createLocalApi({ ...options, allowAppsAuthRelay: false }).handle(
          update({ version: 1, appsAuthRelay: true }),
        )
      )?.status,
    ).toBe(400);
    expect(
      (
        await createLocalApi({ ...options, appsAuthRelayOverride: true }).handle(
          update({ version: 1, appsAuthRelay: false }),
        )
      )?.status,
    ).toBe(400);
    expect(proxyConfig.get().appsAuthRelay).toBe(false);
  });
  it("serves snapshots and updates transformations", async () => {
    let set: TransformationSet = { version: 1, transformations: [] };
    const snapshots: ContextSnapshot[] = [
      {
        id: "session:2",
        sessionId: "session",
        timestamp: "2026-08-15T00:00:00.000Z",
        model: "gpt-5.6-luna",
        tokenization: { encoding: "o200k_base", fallback: false },
        harness: { kind: "tui", version: "0.146.0" },
        requestSequences: [1, 2],
        parts: [],
      },
    ];
    const stats = await StatsStore.open(
      join(await mkdtemp(join(tmpdir(), "act-stats-")), "stats.json"),
    );
    stats.recordTransformations(
      [
        { transformationId: "rule-1", status: "hit", matchCount: 3 },
        { transformationId: "rule-1", status: "miss", matchCount: 0 },
      ],
      "2026-08-15T00:00:00.000Z",
    );
    stats.recordTransformations(
      [{ transformationId: "rule-1", status: "hit", matchCount: 1 }],
      "2026-08-15T00:00:00.000Z",
    );
    for (let index = 0; index < 3; index += 1) {
      stats.recordRouting(
        {
          action: "routed",
          routeSlugs: ["kimi-k3"],
          upstream: "http://127.0.0.1:8317",
          requestedModel: "kimi-k3",
          upstreamModel: "moonshot-kimi-k3",
        },
        "2026-08-15T00:00:00.000Z",
      );
    }
    const api = createLocalApi({
      snapshots: {
        list: async () => snapshots,
        preview: async (id, transformations) => ({
          ...snapshots[0]!,
          id,
          parts: transformations.length === 0 ? [] : snapshots[0]!.parts,
        }),
      },
      transformations: {
        get: () => set,
        replace: async (next) => {
          set = next;
        },
      },
      breakers: {
        openBreakers: () => ({
          "gpt-6-astra::openai.gpt-6-astra-flex": "2026-09-10T01:00:00.000Z",
        }),
      },
      stats,
      ...stubSources({}),
    });

    const response = await api.handle(
      new Request("http://localhost/__agent-context-trimmer/api/snapshots"),
    );
    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({ snapshots });
    const index = await api.handle(
      new Request("http://localhost/__agent-context-trimmer/api/snapshots?view=index"),
    );
    expect(await index?.json()).toEqual({
      snapshots: snapshots.map(({ parts, ...item }) => ({
        ...item,
        revision: expect.any(String),
        partCount: parts.length,
        characters: 0,
      })),
    });
    const detail = await api.handle(
      new Request(
        `http://localhost/__agent-context-trimmer/api/snapshots/${encodeURIComponent(snapshots[0]!.id)}`,
      ),
    );
    expect(await detail?.json()).toEqual({ snapshot: snapshots[0] });
    expect(
      (
        await api.handle(
          new Request("http://localhost/__agent-context-trimmer/api/snapshots/missing"),
        )
      )?.status,
    ).toBe(404);

    const telemetry = await api.handle(
      new Request("http://localhost/__agent-context-trimmer/api/transformation-telemetry"),
    );
    expect(await telemetry?.json()).toEqual({
      telemetry: [
        {
          transformationId: "rule-1",
          hits: 2,
          misses: 1,
          errors: 0,
          matchCount: 4,
          lastRunAt: "2026-08-15T00:00:00.000Z",
        },
      ],
    });

    const routing = await api.handle(
      new Request("http://localhost/__agent-context-trimmer/api/routing-telemetry"),
    );
    expect(await routing?.json()).toEqual({
      telemetry: [
        {
          action: "routed",
          routeSlug: "kimi-k3",
          count: 3,
          lastSeenAt: "2026-08-15T00:00:00.000Z",
        },
      ],
      breakers: { "gpt-6-astra::openai.gpt-6-astra-flex": "2026-09-10T01:00:00.000Z" },
    });

    const next: TransformationSet = {
      version: 1,
      transformations: [
        {
          id: "rule-1",
          name: "Rule one",
          enabled: true,
          scope: {},
          target: { field: "message_text" },
          operation: { type: "replace_all", find: "before", replacement: "after" },
        },
      ],
    };
    const preview = await api.handle(
      new Request("http://localhost/__agent-context-trimmer/api/preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ snapshotId: "session:2", transformations: next.transformations }),
      }),
    );
    expect(preview?.status).toBe(200);
    expect(await preview?.json()).toMatchObject({ snapshot: { id: "session:2" } });

    const update = await api.handle(
      new Request("http://localhost/__agent-context-trimmer/api/transformations", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(next),
      }),
    );
    expect(update?.status).toBe(200);
    expect(set).toEqual(next);

    const reset = await api.handle(
      new Request("http://localhost/__agent-context-trimmer/api/stats/reset", {
        method: "POST",
      }),
    );
    expect(reset?.status).toBe(200);
    const cleared = await api.handle(
      new Request("http://localhost/__agent-context-trimmer/api/transformation-telemetry"),
    );
    expect(await cleared?.json()).toEqual({ telemetry: [] });
  });

  it("returns undefined outside the reserved API surface", async () => {
    const api = createLocalApi({
      snapshots: {
        list: async () => [],
        preview: async () => undefined,
      },
      transformations: {
        get: () => ({ version: 1, transformations: [] }),
        replace: async () => {},
      },
      ...stubSources({}),
    });

    expect(await api.handle(new Request("http://localhost/backend-api/codex/responses"))).toBe(
      undefined,
    );
  });

  it("manages model routes and reports authorization env status", async () => {
    const sources = stubSources({});
    const api = createLocalApi({
      snapshots: {
        list: async () => [],
        preview: async () => undefined,
      },
      transformations: {
        get: () => ({ version: 1, transformations: [] }),
        replace: async () => {},
      },
      ...sources,
    });

    const update = await api.handle(
      new Request("http://localhost/__agent-context-trimmer/api/model-routes", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ version: 1, routes: routeConfigs }),
      }),
    );
    expect(update?.status).toBe(200);
    expect(sources.currentRoutes()).toEqual(routeConfigs);

    const listed = await api.handle(
      new Request("http://localhost/__agent-context-trimmer/api/model-routes"),
    );
    expect(await listed?.json()).toEqual({
      version: 1,
      routes: [
        {
          ...routeConfigs[0],
          effective_tool_policy: {
            function: "pass",
            namespace: "pass",
            custom: "pass",
            web_search: "pass",
            tool_search: "pass",
            other: "pass",
          },
        },
      ],
      adjustments: [],
      fixture_pins: [],
    });

    delete process.env.ACT_TEST_ROUTE_KEY;
    const missing = await api.handle(
      new Request("http://localhost/__agent-context-trimmer/api/model-routes/env-status"),
    );
    expect(await missing?.json()).toEqual({ env: { ACT_TEST_ROUTE_KEY: false } });

    process.env.ACT_TEST_ROUTE_KEY = "local-api-key";
    try {
      const present = await api.handle(
        new Request("http://localhost/__agent-context-trimmer/api/model-routes/env-status"),
      );
      expect(await present?.json()).toEqual({ env: { ACT_TEST_ROUTE_KEY: true } });
    } finally {
      delete process.env.ACT_TEST_ROUTE_KEY;
    }
  });

  it("exposes the effective policy for legacy and explicit route settings", async () => {
    const sources = stubSources({
      routes: [{ ...routeConfigs[0]!, allowed_tool_types: ["function"] }],
    });
    const api = createLocalApi({
      snapshots: { list: async () => [], preview: async () => undefined },
      transformations: {
        get: () => ({ version: 1, transformations: [] }),
        replace: async () => {},
      },
      ...sources,
    });
    const url = "http://localhost/__agent-context-trimmer/api/model-routes";

    const listed = await api.handle(new Request(url));
    const listedBody = (await listed?.json()) as { routes: Record<string, unknown>[] };
    expect(listedBody.routes[0]).toMatchObject({
      allowed_tool_types: ["function"],
      effective_tool_policy: {
        function: "pass",
        namespace: "omit",
        custom: "omit",
        web_search: "omit",
        tool_search: "omit",
        other: "omit",
      },
    });

    const update = await api.handle(
      new Request(url, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          version: 1,
          routes: [{ ...routeConfigs[0], tool_policy: { web_search: "reject" } }],
        }),
      }),
    );
    expect(update?.status).toBe(200);
    const updatedBody = (await update?.json()) as { routes: Record<string, unknown>[] };
    expect(updatedBody.routes[0]).toMatchObject({
      tool_policy: { web_search: "reject" },
      effective_tool_policy: {
        function: "pass",
        namespace: "pass",
        custom: "pass",
        web_search: "reject",
        tool_search: "pass",
        other: "pass",
      },
    });
    expect(sources.currentRoutes()[0]).not.toHaveProperty("effective_tool_policy");
  });

  it("serves the observed upstream responses cache", async () => {
    const cacheState = {
      models: { fetchedAt: "2026-09-10T00:00:00.000Z", body: { models: [{ slug: "gpt-5.6" }] } },
      configBundle: { fetchedAt: "2026-09-10T00:00:01.000Z", body: { requirements_toml: null } },
    };
    const api = createLocalApi({
      snapshots: {
        list: async () => [],
        preview: async () => undefined,
      },
      transformations: {
        get: () => ({ version: 1, transformations: [] }),
        replace: async () => {},
      },
      ...stubSources({}),
      upstreamCache: { get: () => cacheState, observe: async () => {} },
    });

    const response = await api.handle(
      new Request("http://localhost/__agent-context-trimmer/api/upstream-cache"),
    );

    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual(cacheState);
  });

  it("rejects invalid model routes with a validation error", async () => {
    const sources = stubSources({});
    const api = createLocalApi({
      snapshots: {
        list: async () => [],
        preview: async () => undefined,
      },
      transformations: {
        get: () => ({ version: 1, transformations: [] }),
        replace: async () => {},
      },
      ...sources,
    });

    const update = await api.handle(
      new Request("http://localhost/__agent-context-trimmer/api/model-routes", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ version: 1, routes: [{ model: {} }] }),
      }),
    );
    expect(update?.status).toBe(400);
    expect(await update?.json()).toEqual({
      error: "route[0].authorization_env must be a non-empty string",
    });
    expect(sources.currentRoutes()).toEqual([]);
  });

  it("rejects a tool policy action before saving a route", async () => {
    const sources = stubSources({});
    const api = createLocalApi({
      snapshots: { list: async () => [], preview: async () => undefined },
      transformations: {
        get: () => ({ version: 1, transformations: [] }),
        replace: async () => {},
      },
      ...sources,
    });

    const update = await api.handle(
      new Request("http://localhost/__agent-context-trimmer/api/model-routes", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          version: 1,
          routes: [{ ...routeConfigs[0], tool_policy: { web_search: "broker" } }],
        }),
      }),
    );

    expect(update?.status).toBe(400);
    expect(await update?.json()).toEqual({
      error:
        'route[0].tool_policy.web_search action "broker" is not implemented for responses routes',
    });
    expect(sources.currentRoutes()).toEqual([]);
  });

  it("manages the config bundle override", async () => {
    const sources = stubSources({});
    const api = createLocalApi({
      snapshots: {
        list: async () => [],
        preview: async () => undefined,
      },
      transformations: {
        get: () => ({ version: 1, transformations: [] }),
        replace: async () => {},
      },
      ...sources,
    });

    const initial = await api.handle(
      new Request("http://localhost/__agent-context-trimmer/api/config-bundle"),
    );
    expect(await initial?.json()).toEqual({ version: 1, enabled: false, bundle: null });

    const override: ConfigBundleOverride = {
      version: 1,
      enabled: true,
      bundle: { requirements_toml: null },
    };
    const update = await api.handle(
      new Request("http://localhost/__agent-context-trimmer/api/config-bundle", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(override),
      }),
    );
    expect(update?.status).toBe(200);
    expect(sources.currentBundle()).toEqual(override);

    const removed = await api.handle(
      new Request("http://localhost/__agent-context-trimmer/api/config-bundle", {
        method: "DELETE",
      }),
    );
    expect(removed?.status).toBe(200);
    expect(sources.currentBundle()).toEqual({ version: 1, enabled: false, bundle: null });
  });

  it("rejects an enabled config bundle override without an object bundle", async () => {
    const sources = stubSources({});
    const api = createLocalApi({
      snapshots: {
        list: async () => [],
        preview: async () => undefined,
      },
      transformations: {
        get: () => ({ version: 1, transformations: [] }),
        replace: async () => {},
      },
      ...sources,
    });

    const update = await api.handle(
      new Request("http://localhost/__agent-context-trimmer/api/config-bundle", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ version: 1, enabled: true, bundle: "not-an-object" }),
      }),
    );
    expect(update?.status).toBe(400);
    expect(await update?.json()).toEqual({
      error: "enabled config bundle override requires a JSON object bundle",
    });
  });

  it("exposes codex config toggle state and applies toggles", async () => {
    const calls: Array<{ key: string; enabled: boolean }> = [];
    const toggle = {
      key: "openai_base_url",
      label: "Responses & models",
      description: "Route Responses traffic through the proxy.",
      managedValue: "http://127.0.0.1:8765/backend-api/codex",
      enabled: true,
    };
    const api = createLocalApi({
      snapshots: {
        list: async () => [],
        preview: async () => undefined,
      },
      transformations: {
        get: () => ({ version: 1, transformations: [] }),
        replace: async () => {},
      },
      ...stubSources({}),
      codexConfig: {
        state: async () => ({ path: "/tmp/act-test/config.toml", exists: true, toggles: [] }),
        setEnabled: async (key: string, enabled: boolean) => {
          calls.push({ key, enabled });
          return { path: "/tmp/act-test/config.toml", exists: true, toggles: [toggle] };
        },
      },
    });

    const state = await api.handle(
      new Request("http://localhost/__agent-context-trimmer/api/codex-config"),
    );
    expect(state?.status).toBe(200);
    expect(await state?.json()).toEqual({
      path: "/tmp/act-test/config.toml",
      exists: true,
      toggles: [],
    });

    const update = await api.handle(
      new Request("http://localhost/__agent-context-trimmer/api/codex-config", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: "openai_base_url", enabled: true }),
      }),
    );
    expect(update?.status).toBe(200);
    expect(calls).toEqual([{ key: "openai_base_url", enabled: true }]);
    expect(await update?.json()).toMatchObject({ toggles: [toggle] });

    const invalid = await api.handle(
      new Request("http://localhost/__agent-context-trimmer/api/codex-config", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: "openai_base_url" }),
      }),
    );
    expect(invalid?.status).toBe(400);
  });
});
