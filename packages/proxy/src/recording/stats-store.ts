import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type {
  TransformationExecution,
  TransformationTelemetry,
} from "../context/transformation.ts";
import type { CaptureRouting } from "./capture.ts";

/** Per-target aggregates for one upstream model of a route. */
export interface RouteTargetStats {
  attempts: number;
  served: number;
  failed: number;
  totalLatencyMs: number;
  lastStatus?: number;
  lastSeenAt: string;
}

/** Per-route aggregates across all of its targets. */
export interface RouteStats {
  requests: number;
  served: number;
  failed: number;
  totalLatencyMs: number;
  lastSeenAt: string;
  targets: Record<string, RouteTargetStats>;
}

/** Routing telemetry entry served to the UI: action counts plus route stats. */
export interface RoutingTelemetryEntry {
  action: string;
  routeSlug?: string;
  count: number;
  lastSeenAt: string;
  served?: number;
  failed?: number;
  avgLatencyMs?: number;
  targets?: Record<string, RouteTargetStats & { avgLatencyMs: number }>;
}

interface StatsFileData {
  version: 1;
  transformations: Record<string, TransformationTelemetry>;
  routes: Record<string, RouteStats>;
  /** Action counts for non-routed routing events (bundle-override, …). */
  actions: Record<
    string,
    { action: string; routeSlug?: string; count: number; lastSeenAt: string }
  >;
}

const EMPTY_DATA: StatsFileData = {
  version: 1,
  transformations: {},
  routes: {},
  actions: {},
};

/** Idle delay after the last mutation before stats are written to disk. */
const SAVE_DEBOUNCE_MS = 1500;

/**
 * Persisted, event-time telemetry counters. Unlike capture-derived telemetry
 * this survives capture rotation and metadata-mode latching, and it is cheap:
 * counters update in memory as events are recorded and the file is written
 * once the proxy goes idle (debounced), atomically via tmp + rename.
 */
export class StatsStore {
  readonly #path: string;
  #data: StatsFileData;
  #saveTimer: ReturnType<typeof setTimeout> | undefined;
  #saving: Promise<void> | undefined;

  private constructor(path: string, data: StatsFileData) {
    this.#path = path;
    this.#data = data;
  }

  static async open(path: string): Promise<StatsStore> {
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch {
      return new StatsStore(path, structuredClone(EMPTY_DATA));
    }
    try {
      const parsed = JSON.parse(raw) as Partial<StatsFileData>;
      return new StatsStore(path, {
        version: 1,
        transformations: parsed.transformations ?? {},
        routes: parsed.routes ?? {},
        actions: parsed.actions ?? {},
      });
    } catch {
      // A corrupt cache must not break the proxy; start fresh.
      return new StatsStore(path, structuredClone(EMPTY_DATA));
    }
  }

  recordTransformations(executions: TransformationExecution[], timestamp: string): void {
    if (executions.length === 0) return;
    for (const execution of executions) {
      const current = this.#data.transformations[execution.transformationId] ?? {
        transformationId: execution.transformationId,
        hits: 0,
        misses: 0,
        errors: 0,
        matchCount: 0,
        lastRunAt: timestamp,
      };
      current.hits += execution.status === "hit" ? 1 : 0;
      current.misses += execution.status === "miss" ? 1 : 0;
      current.errors += execution.status === "error" ? 1 : 0;
      current.matchCount += execution.matchCount;
      if (timestamp > current.lastRunAt) current.lastRunAt = timestamp;
      this.#data.transformations[execution.transformationId] = current;
    }
    this.#scheduleSave();
  }

  recordRouting(routing: CaptureRouting, timestamp: string): void {
    const slug = routing.action === "routed" ? routing.routeSlugs?.[0] : undefined;
    const key = slug === undefined ? routing.action : `${routing.action}:${slug}`;
    const action =
      this.#data.actions[key] ??
      ({
        action: routing.action,
        ...(slug === undefined ? {} : { routeSlug: slug }),
        count: 0,
        lastSeenAt: timestamp,
      } satisfies StatsFileData["actions"][string]);
    action.count += 1;
    if (timestamp > action.lastSeenAt) action.lastSeenAt = timestamp;
    this.#data.actions[key] = action;

    if (routing.action === "routed" && slug !== undefined && routing.attempts !== undefined) {
      this.#recordRouteAttempts(slug, routing.attempts, timestamp);
    }
    this.#scheduleSave();
  }

  #recordRouteAttempts(
    slug: string,
    attempts: NonNullable<CaptureRouting["attempts"]>,
    timestamp: string,
  ): void {
    const route = this.#data.routes[slug] ?? {
      requests: 0,
      served: 0,
      failed: 0,
      totalLatencyMs: 0,
      lastSeenAt: timestamp,
      targets: {},
    };
    route.requests += 1;
    const served = attempts.at(-1)?.outcome === "served";
    route.served += served ? 1 : 0;
    route.failed += served ? 0 : 1;
    if (timestamp > route.lastSeenAt) route.lastSeenAt = timestamp;
    for (const attempt of attempts) {
      route.totalLatencyMs += attempt.durationMs ?? 0;
      const target = route.targets[attempt.upstreamModel] ?? {
        attempts: 0,
        served: 0,
        failed: 0,
        totalLatencyMs: 0,
        lastSeenAt: timestamp,
      };
      target.attempts += 1;
      target.served += attempt.outcome === "served" ? 1 : 0;
      target.failed += attempt.outcome === "served" ? 0 : 1;
      target.totalLatencyMs += attempt.durationMs ?? 0;
      if (attempt.status !== undefined) target.lastStatus = attempt.status;
      if (timestamp > target.lastSeenAt) target.lastSeenAt = timestamp;
      route.targets[attempt.upstreamModel] = target;
    }
    this.#data.routes[slug] = route;
  }

  transformationTelemetry(): TransformationTelemetry[] {
    return Object.values(this.#data.transformations).sort((left, right) =>
      left.transformationId.localeCompare(right.transformationId),
    );
  }

  routingTelemetry(): RoutingTelemetryEntry[] {
    return Object.values(this.#data.actions)
      .map((action) => {
        const route =
          action.routeSlug === undefined ? undefined : this.#data.routes[action.routeSlug];
        return {
          ...action,
          ...(route === undefined
            ? {}
            : {
                served: route.served,
                failed: route.failed,
                avgLatencyMs: average(route.totalLatencyMs, route.requests),
                targets: Object.fromEntries(
                  Object.entries(route.targets).map(([model, target]) => [
                    model,
                    { ...target, avgLatencyMs: average(target.totalLatencyMs, target.attempts) },
                  ]),
                ),
              }),
        };
      })
      .sort((left, right) => keyOf(left).localeCompare(keyOf(right)));

    function keyOf(entry: { action: string; routeSlug?: string }): string {
      return `${entry.action}:${entry.routeSlug ?? ""}`;
    }
  }

  /** Clears every counter and persists the empty state. */
  async reset(): Promise<void> {
    this.#data = structuredClone(EMPTY_DATA);
    await this.flush();
  }

  /** Writes immediately when a save is pending; safe to call on shutdown. */
  async flush(): Promise<void> {
    if (this.#saveTimer !== undefined) {
      clearTimeout(this.#saveTimer);
      this.#saveTimer = undefined;
    }
    await this.#saving;
    await this.#write().catch(() => {});
  }

  #scheduleSave(): void {
    if (this.#saveTimer !== undefined) clearTimeout(this.#saveTimer);
    this.#saveTimer = setTimeout(() => {
      this.#saveTimer = undefined;
      this.#saving = this.#write()
        .catch(() => {})
        .finally(() => {
          this.#saving = undefined;
        });
    }, SAVE_DEBOUNCE_MS);
    this.#saveTimer.unref?.();
  }

  async #write(): Promise<void> {
    await mkdir(dirname(this.#path), { recursive: true });
    const temporary = join(
      dirname(this.#path),
      `.${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}.tmp`,
    );
    await writeFile(temporary, `${JSON.stringify(this.#data, null, 2)}\n`, "utf8");
    await rename(temporary, this.#path);
  }
}

function average(totalMs: number, count: number): number {
  return count === 0 ? 0 : Math.round(totalMs / count);
}
