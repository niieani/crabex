import type { TransformationStore } from "../config/transformation-store.ts";
import { parseTransformationSet } from "../config/transformation-store.ts";
import type { CodexConfigManager } from "../config/codex-config.ts";
import type { ConfigBundleStore } from "../config/config-bundle-store.ts";
import {
  EMPTY_CONFIG_BUNDLE_OVERRIDE,
  parseConfigBundleOverride,
} from "../config/config-bundle-store.ts";
import type { ModelRouteStore } from "../config/model-route-store.ts";
import { parseModelRouteSet } from "../routing/model-routes.ts";
import type { SnapshotSource } from "../recording/capture-repository.ts";

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
}): LocalApi {
  return {
    async handle(request) {
      const url = new URL(request.url);
      if (!url.pathname.startsWith(API_PREFIX)) return undefined;
      try {
        if (url.pathname === `${API_PREFIX}/snapshots` && request.method === "GET") {
          return json({ snapshots: await options.snapshots.list() });
        }
        if (url.pathname === `${API_PREFIX}/transformations` && request.method === "GET") {
          return json(options.transformations.get());
        }
        if (url.pathname === `${API_PREFIX}/transformation-telemetry` && request.method === "GET") {
          return json({ telemetry: await options.snapshots.transformationTelemetry() });
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
          return json({ version: 1, routes: options.modelRoutes.get() });
        }
        if (url.pathname === `${API_PREFIX}/model-routes` && request.method === "PUT") {
          const routes = parseModelRouteSet(await request.json());
          await options.modelRoutes.replace(routes);
          return json({ version: 1, routes });
        }
        if (url.pathname === `${API_PREFIX}/model-routes/env-status` && request.method === "GET") {
          const names = [
            ...new Set(options.modelRoutes.get().map((route) => route.authorization_env)),
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

function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
