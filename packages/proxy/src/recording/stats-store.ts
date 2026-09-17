import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type {
  TransformationExecution,
  TransformationTelemetry,
} from "../context/transformation.ts";
import type { CaptureRouting, CaptureUsage } from "./capture.ts";

/** Token-cache samples collected from `response.completed` usage. */
export interface CacheUsageStats {
  samples: number;
  inputTokens: number;
  cachedTokens: number;
}

/** Per-target aggregates for one upstream model of a route. */
export interface RouteTargetStats {
  attempts: number;
  served: number;
  failed: number;
  /** Individual attempts classified as `retry` (same target, try again). */
  retries: number;
  /** Requests that included at least one retry on this target. */
  retriedRequests: number;
  /** Subset of `retriedRequests` that later served on the same target. */
  retryRecoveries: number;
  /** Attempts that left this target for the next one (`failover`). */
  failovers: number;
  totalLatencyMs: number;
  lastStatus?: number;
  lastSeenAt: string;
  cache?: CacheUsageStats;
}

/** Per-route aggregates across all of its targets. */
export interface RouteStats {
  requests: number;
  served: number;
  failed: number;
  /** Requests served by a later target than the first one tried. */
  failovers: number;
  totalLatencyMs: number;
  lastSeenAt: string;
  targets: Record<string, RouteTargetStats>;
  cache?: CacheUsageStats;
  fallbackCache?: CacheUsageStats;
}

/** Routing telemetry entry served to the UI: action counts plus route stats. */
export interface RoutingTelemetryEntry {
  action: string;
  routeSlug?: string;
  count: number;
  lastSeenAt: string;
  served?: number;
  failed?: number;
  failovers?: number;
  errorRate?: number;
  avgLatencyMs?: number;
  cacheHitRate?: number;
  fallbackCacheHitRate?: number;
  cache?: CacheUsageStats;
  fallbackCache?: CacheUsageStats;
  targets?: Record<string, RouteTargetTelemetry>;
}

/** Per-target telemetry with computed rates. */
export interface RouteTargetTelemetry extends RouteTargetStats {
  avgLatencyMs: number;
  errorRate?: number;
  retrySuccessRate?: number;
  cacheHitRate?: number;
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
        routes: normalizeRoutes(parsed.routes ?? {}),
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

  /**
   * Attributes `response.completed` token usage to the route/target that
   * served the request. Fallback serves (later target than the first tried)
   * are also tallied on `fallbackCache` so we can see whether a flex→standard
   * switch kept the prompt prefix cached.
   */
  recordUsage(routing: CaptureRouting, usage: CaptureUsage, timestamp: string): void {
    const slug = routing.action === "routed" ? routing.routeSlugs?.[0] : undefined;
    if (slug === undefined) return;
    const servedBy =
      routing.upstreamModel ??
      [...(routing.attempts ?? [])].reverse().find((attempt) => attempt.outcome === "served")
        ?.upstreamModel;
    if (servedBy === undefined) return;
    const route = this.#data.routes[slug];
    if (route === undefined) return;

    addCache(route, "cache", usage);
    if (isFallbackServe(routing.attempts ?? [])) addCache(route, "fallbackCache", usage);
    const target = route.targets[servedBy];
    if (target !== undefined) addCache(target, "cache", usage);
    if (timestamp > route.lastSeenAt) route.lastSeenAt = timestamp;
    this.#scheduleSave();
  }

  #recordRouteAttempts(
    slug: string,
    attempts: NonNullable<CaptureRouting["attempts"]>,
    timestamp: string,
  ): void {
    const route = this.#data.routes[slug] ?? emptyRoute(timestamp);
    route.requests += 1;
    const served = attempts.at(-1)?.outcome === "served";
    route.served += served ? 1 : 0;
    route.failed += served ? 0 : 1;
    if (isFallbackServe(attempts)) route.failovers += 1;
    if (timestamp > route.lastSeenAt) route.lastSeenAt = timestamp;

    const byTarget = new Map<string, NonNullable<CaptureRouting["attempts"]>>();
    for (const attempt of attempts) {
      route.totalLatencyMs += attempt.durationMs ?? 0;
      const target = route.targets[attempt.upstreamModel] ?? emptyTarget(timestamp);
      target.attempts += 1;
      target.served += attempt.outcome === "served" ? 1 : 0;
      target.failed += attempt.outcome === "served" ? 0 : 1;
      target.retries += attempt.outcome === "retry" ? 1 : 0;
      target.failovers += attempt.outcome === "failover" ? 1 : 0;
      target.totalLatencyMs += attempt.durationMs ?? 0;
      if (attempt.status !== undefined) target.lastStatus = attempt.status;
      if (timestamp > target.lastSeenAt) target.lastSeenAt = timestamp;
      route.targets[attempt.upstreamModel] = target;
      const list = byTarget.get(attempt.upstreamModel) ?? [];
      list.push(attempt);
      byTarget.set(attempt.upstreamModel, list);
    }
    for (const [model, targetAttempts] of byTarget) {
      const target = route.targets[model];
      if (target === undefined) continue;
      if (!targetAttempts.some((attempt) => attempt.outcome === "retry")) continue;
      target.retriedRequests += 1;
      if (targetAttempts.some((attempt) => attempt.outcome === "served")) {
        target.retryRecoveries += 1;
      }
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
                failovers: route.failovers,
                errorRate: percent(route.failed, route.requests),
                avgLatencyMs: average(route.totalLatencyMs, route.requests),
                cacheHitRate: cacheHitRate(route.cache),
                fallbackCacheHitRate: cacheHitRate(route.fallbackCache),
                ...(route.cache === undefined ? {} : { cache: route.cache }),
                ...(route.fallbackCache === undefined
                  ? {}
                  : { fallbackCache: route.fallbackCache }),
                targets: Object.fromEntries(
                  Object.entries(route.targets).map(([model, target]) => [
                    model,
                    {
                      ...target,
                      avgLatencyMs: average(target.totalLatencyMs, target.attempts),
                      errorRate: percent(target.failed, target.attempts),
                      retrySuccessRate: percent(target.retryRecoveries, target.retriedRequests),
                      cacheHitRate: cacheHitRate(target.cache),
                    },
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

function percent(numerator: number, denominator: number): number | undefined {
  if (denominator === 0) return undefined;
  return Math.round((numerator / denominator) * 100);
}

function cacheHitRate(cache: CacheUsageStats | undefined): number | undefined {
  if (cache === undefined || cache.samples === 0 || cache.inputTokens === 0) return undefined;
  return Math.round((cache.cachedTokens / cache.inputTokens) * 100);
}

/** Served by a different upstream model than the first one we tried. */
export function isFallbackServe(attempts: NonNullable<CaptureRouting["attempts"]>): boolean {
  const served = [...attempts].reverse().find((attempt) => attempt.outcome === "served");
  if (served === undefined) return false;
  return attempts[0]?.upstreamModel !== served.upstreamModel;
}

function emptyRoute(timestamp: string): RouteStats {
  return {
    requests: 0,
    served: 0,
    failed: 0,
    failovers: 0,
    totalLatencyMs: 0,
    lastSeenAt: timestamp,
    targets: {},
  };
}

function emptyTarget(timestamp: string): RouteTargetStats {
  return {
    attempts: 0,
    served: 0,
    failed: 0,
    retries: 0,
    retriedRequests: 0,
    retryRecoveries: 0,
    failovers: 0,
    totalLatencyMs: 0,
    lastSeenAt: timestamp,
  };
}

function addCache(
  holder: { cache?: CacheUsageStats; fallbackCache?: CacheUsageStats },
  key: "cache" | "fallbackCache",
  usage: CaptureUsage,
): void {
  const current = holder[key] ?? { samples: 0, inputTokens: 0, cachedTokens: 0 };
  current.samples += 1;
  current.inputTokens += usage.inputTokens;
  current.cachedTokens += usage.cachedTokens;
  holder[key] = current;
}

function normalizeRoutes(routes: Record<string, RouteStats>): Record<string, RouteStats> {
  return Object.fromEntries(
    Object.entries(routes).map(([slug, route]) => [
      slug,
      {
        ...emptyRoute(route.lastSeenAt ?? new Date(0).toISOString()),
        ...route,
        failovers: route.failovers ?? 0,
        targets: Object.fromEntries(
          Object.entries(route.targets ?? {}).map(([model, target]) => [
            model,
            {
              ...emptyTarget(target.lastSeenAt ?? route.lastSeenAt ?? new Date(0).toISOString()),
              ...target,
              retries: target.retries ?? 0,
              retriedRequests: target.retriedRequests ?? 0,
              retryRecoveries: target.retryRecoveries ?? 0,
              failovers: target.failovers ?? 0,
            },
          ]),
        ),
      },
    ]),
  );
}
