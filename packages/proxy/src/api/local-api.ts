import { createHash } from "node:crypto";
import type { TlsStatus } from "../service/tls.ts";
import type { TransformationStore } from "../config/transformation-store.ts";
import { parseTransformationSet } from "../config/transformation-store.ts";
import type { CodexConfigManager } from "../config/codex-config.ts";
import { parseProxyConfig, type ProxyConfigStore } from "../config/proxy-config-store.ts";
import type { ConfigBundleStore } from "../config/config-bundle-store.ts";
import {
  EMPTY_CONFIG_BUNDLE_OVERRIDE,
  parseConfigBundleOverride,
} from "../config/config-bundle-store.ts";
import type { ModelRouteStore } from "../config/model-route-store.ts";
import type { UpstreamCacheStore } from "../config/upstream-cache.ts";
import {
  modelRouteFromConfig,
  parseModelRouteSet,
  type ModelRouteSetData,
} from "../routing/model-routes.ts";
import { allowedToolActions } from "../routing/tool-policy.ts";
import { brokerRouteEligibility } from "../proxy/search-broker.ts";
import { modelsFixture } from "../routing/models-fixture.ts";
import type { SnapshotSource } from "../recording/capture-repository.ts";
import type { StatsStore } from "../recording/stats-store.ts";
import type { LiveRequestStore } from "../requests/live-request-store.ts";

const API_PREFIX = "/__agent-context-trimmer/api";

export interface LocalApi {
  handle(request: Request): Promise<Response | undefined>;
}

export function createLocalApi(options: {
  snapshots: SnapshotSource;
  transformations: TransformationStore;
  modelRoutes: ModelRouteStore;
  configBundle: ConfigBundleStore;
  codexConfig: CodexConfigManager;
  proxyConfig?: ProxyConfigStore;
  tlsStatus?: () => Promise<TlsStatus>;
  appsAuthRelayOverride?: boolean;
  allowAppsAuthRelay?: boolean;
  upstreamCache: UpstreamCacheStore;
  breakers?: { openBreakers(): Record<string, string> };
  stats?: StatsStore;
  requests?: LiveRequestStore;
}): LocalApi {
  return {
    async handle(request) {
      const url = new URL(request.url);
      if (!url.pathname.startsWith(API_PREFIX)) return undefined;
      try {
        if (url.pathname === `${API_PREFIX}/tls-status`) {
          if (request.method !== "GET") return json({ error: "method not allowed" }, 405);
          return json((await options.tlsStatus?.()) ?? { enabled: false });
        }
        if (url.pathname === `${API_PREFIX}/proxy-config` && options.proxyConfig !== undefined) {
          if (request.method === "PUT") {
            const update: unknown = await request.json();
            if (typeof update !== "object" || update === null || Array.isArray(update))
              throw new Error("invalid proxy config");
            if (
              options.appsAuthRelayOverride !== undefined &&
              Object.hasOwn(update, "appsAuthRelay")
            )
              throw new Error(
                "Apps authentication relay is overridden by the command line; restart without the override to edit it",
              );
            const current = options.proxyConfig.get();
            const routedAgentUpdate = (update as Record<string, unknown>).routed_agents;
            const config = parseProxyConfig({
              ...current,
              ...update,
              routed_agents:
                routedAgentUpdate === undefined ||
                (typeof routedAgentUpdate === "object" &&
                  routedAgentUpdate !== null &&
                  !Array.isArray(routedAgentUpdate))
                  ? { ...current.routed_agents, ...routedAgentUpdate }
                  : routedAgentUpdate,
            });
            if (
              Object.hasOwn(update, "appsAuthRelay") &&
              config.appsAuthRelay &&
              options.allowAppsAuthRelay === false
            )
              throw new Error("Apps authentication relay requires a loopback listener");
            await options.proxyConfig.replace(config);
          } else if (request.method !== "GET") return json({ error: "method not allowed" }, 405);
          return json({
            path: options.proxyConfig.path,
            ...options.proxyConfig.get(),
            appsAuthRelayOverride: options.appsAuthRelayOverride,
            allowAppsAuthRelay: options.allowAppsAuthRelay ?? true,
          });
        }
        if (url.pathname === `${API_PREFIX}/snapshots` && request.method === "GET") {
          const snapshots = await options.snapshots.list();
          if (url.searchParams.get("view") === "index") {
            return json({
              snapshots: snapshots.map(({ parts, ...snapshot }) => ({
                ...snapshot,
                revision: createHash("sha256")
                  .update(
                    JSON.stringify([
                      parts.map((part) => [part.digest, part.originalText, part.deleted]),
                      snapshot.usage,
                    ]),
                  )
                  .digest("hex")
                  .slice(0, 16),
                partCount: parts.length,
                characters: parts.reduce((sum, part) => sum + part.characters, 0),
              })),
            });
          }
          return json({ snapshots });
        }
        if (url.pathname.startsWith(`${API_PREFIX}/snapshots/`) && request.method === "GET") {
          const id = decodeURIComponent(url.pathname.slice(`${API_PREFIX}/snapshots/`.length));
          const snapshot = (await options.snapshots.list()).find((item) => item.id === id);
          return snapshot ? json({ snapshot }) : json({ error: "snapshot not found" }, 404);
        }
        if (url.pathname === `${API_PREFIX}/transformations` && request.method === "GET") {
          return json(options.transformations.get());
        }
        if (url.pathname === `${API_PREFIX}/transformation-telemetry` && request.method === "GET") {
          return json({ telemetry: options.stats?.transformationTelemetry() ?? [] });
        }
        if (url.pathname === `${API_PREFIX}/routing-telemetry` && request.method === "GET") {
          return json({
            telemetry: options.stats?.routingTelemetry() ?? [],
            breakers: options.breakers?.openBreakers() ?? {},
          });
        }
        if (url.pathname === `${API_PREFIX}/live-requests` && request.method === "GET") {
          return json(options.requests?.snapshot() ?? { active: [], recent: [] });
        }
        if (url.pathname === `${API_PREFIX}/stats/reset` && request.method === "POST") {
          await options.stats?.reset();
          return json({ ok: true });
        }
        if (url.pathname === `${API_PREFIX}/upstream-cache` && request.method === "GET") {
          return json(options.upstreamCache.get());
        }
        if (url.pathname === `${API_PREFIX}/models-fixture` && request.method === "GET") {
          return json({ models: modelsFixture() });
        }
        if (url.pathname === `${API_PREFIX}/preview` && request.method === "POST") {
          const body = (await request.json()) as Record<string, unknown>;
          if (typeof body.snapshotId !== "string" || !Array.isArray(body.transformations)) {
            throw new Error("invalid preview request");
          }
          const set = parseTransformationSet({ version: 1, transformations: body.transformations });
          const snapshot = await options.snapshots.preview(body.snapshotId, set.transformations);
          return snapshot === undefined
            ? json({ error: "snapshot not found" }, 404)
            : json({ snapshot });
        }
        if (url.pathname === `${API_PREFIX}/transformations` && request.method === "PUT") {
          const set = parseTransformationSet(await request.json());
          await options.transformations.replace(set);
          return json(set);
        }
        if (url.pathname === `${API_PREFIX}/model-routes` && request.method === "GET") {
          return json(modelRoutesResponse(options.modelRoutes.get()));
        }
        if (url.pathname === `${API_PREFIX}/model-routes` && request.method === "PUT") {
          const set = parseModelRouteSet(await request.json());
          await options.modelRoutes.replace(set);
          return json(modelRoutesResponse(options.modelRoutes.get()));
        }
        if (url.pathname === `${API_PREFIX}/model-routes/env-status` && request.method === "GET") {
          const names = [
            ...new Set(options.modelRoutes.get().routes.map((route) => route.authorization_env)),
          ];
          return json({
            env: Object.fromEntries(
              names.map((name) => [name, (process.env[name]?.length ?? 0) > 0]),
            ),
          });
        }
        if (url.pathname === `${API_PREFIX}/config-bundle` && request.method === "GET") {
          return json(options.configBundle.get());
        }
        if (url.pathname === `${API_PREFIX}/config-bundle` && request.method === "PUT") {
          const override = parseConfigBundleOverride(await request.json());
          await options.configBundle.replace(override);
          return json(override);
        }
        if (url.pathname === `${API_PREFIX}/config-bundle` && request.method === "DELETE") {
          await options.configBundle.replace(EMPTY_CONFIG_BUNDLE_OVERRIDE);
          return json(options.configBundle.get());
        }
        if (url.pathname === `${API_PREFIX}/codex-config` && request.method === "GET") {
          return json(await options.codexConfig.state());
        }
        if (url.pathname === `${API_PREFIX}/codex-config` && request.method === "PUT") {
          const body = (await request.json()) as Record<string, unknown>;
          if (typeof body.key !== "string" || typeof body.enabled !== "boolean") {
            throw new Error("invalid codex config request");
          }
          return json(await options.codexConfig.setEnabled(body.key, body.enabled));
        }
        return json({ error: "not found" }, 404);
      } catch (error) {
        return json({ error: errorMessage(error) }, 400);
      }
    },
  };
}

function modelRoutesResponse(set: ModelRouteSetData): Record<string, unknown> {
  return {
    version: 1,
    ...set,
    routes: set.routes.map((route) => {
      const compiled = modelRouteFromConfig(route);
      return {
        ...route,
        effective_handoff_class: compiled.handoffClass,
        handoff_class_options:
          compiled.api === "anthropic-messages"
            ? ["plaintext"]
            : compiled.transport === "ws"
              ? ["native-encrypted"]
              : ["plaintext", "native-encrypted"],
        effective_tool_policy: compiled.toolPolicy,
        tool_policy_actions: allowedToolActions(route.api ?? "responses", compiled.transport),
        search_broker_eligibility: brokerRouteEligibility(compiled, process.env),
      };
    }),
  };
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
