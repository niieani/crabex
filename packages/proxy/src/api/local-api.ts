import type { TransformationStore } from "../config/transformation-store.ts";
import { parseTransformationSet } from "../config/transformation-store.ts";
import type { SnapshotSource } from "../recording/capture-repository.ts";

const API_PREFIX = "/__agent-context-trimmer/api";

export interface LocalApi {
  handle(request: Request): Promise<Response | undefined>;
}

export function createLocalApi(options: {
  snapshots: SnapshotSource;
  transformations: TransformationStore;
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
