import { resolveEventStreamResponse } from "../proxy/responses-bridge.ts";
import type { ModelRoute, RouteRetryPolicy, RouteTarget } from "./model-routes.ts";

/**
 * How to react to a failed attempt:
 * - retry: try the same target again while it has attempts left
 * - failover: move straight to the next target
 * - fatal: return the response to the client untouched
 */
export type FailureClass = "retry" | "failover" | "fatal";

/** Statuses that mean "this model, not this request" — no point retrying the same target. */
const FAILOVER_STATUSES = new Set([403, 404, 410, 422]);

export function classifyHttpFailure(status: number, retryOn: readonly number[]): FailureClass {
  if (retryOn.includes(status)) return "retry";
  if (FAILOVER_STATUSES.has(status)) return "failover";
  return "fatal";
}

export function backoffDelayMs(backoffMs: readonly number[], attemptIndex: number): number {
  const base = backoffMs[Math.min(attemptIndex, backoffMs.length - 1)] ?? 0;
  // Full jitter: uniform in [0, base] keeps concurrent clients from lock-stepping.
  return Math.floor(Math.random() * (base + 1));
}

export function breakerKey(route: ModelRoute, target: RouteTarget): string {
  return `${route.model.slug}::${target.upstreamModel ?? route.model.slug}`;
}

export interface RouteAttempt {
  upstreamModel: string;
  outcome: "served" | "retry" | "failover" | "fatal" | "breaker-open" | "network-error";
  status?: number;
  /** Wall-clock time the attempt took, including draining the error body. */
  durationMs?: number;
}

/**
 * In-memory circuit breakers, one per route target. A target's breaker opens
 * after `failures` consecutive exhausted episodes and then skips the target
 * for `cooldownMs`; the first request after the cooldown probes half-open.
 */
export class TargetBreakers {
  readonly #episodes = new Map<string, number>();
  readonly #openUntil = new Map<string, number>();
  readonly #now: () => number;

  constructor(now: () => number = () => Date.now()) {
    this.#now = now;
  }

  isOpen(key: string): boolean {
    const until = this.#openUntil.get(key);
    if (until === undefined) return false;
    if (this.#now() < until) return true;
    this.#openUntil.delete(key);
    return false;
  }

  recordSuccess(key: string): void {
    this.#episodes.delete(key);
    this.#openUntil.delete(key);
  }

  recordFailureEpisode(key: string, policy: RouteRetryPolicy["breaker"]): void {
    const count = (this.#episodes.get(key) ?? 0) + 1;
    if (count >= policy.failures) {
      this.#openUntil.set(key, this.#now() + policy.cooldownMs);
      this.#episodes.delete(key);
    } else {
      this.#episodes.set(key, count);
    }
  }

  /** Snapshot for telemetry/UI: which breakers are currently open. */
  openBreakers(): Record<string, string> {
    const open: Record<string, string> = {};
    for (const [key, until] of this.#openUntil) {
      if (this.#now() < until) open[key] = new Date(until).toISOString();
    }
    return open;
  }
}

export interface FetchWithFailoverOptions {
  route: ModelRoute;
  /** Builds the request init for a target — the model rewrite happens here. */
  requestFor: (target: RouteTarget) => { url: URL; init: RequestInit };
  breakers?: TargetBreakers;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export interface FailoverResult {
  response: Response;
  attempts: RouteAttempt[];
  /** The target model that produced `response`, when one served (2xx). */
  servedBy?: string;
}

/**
 * Sequentially tries the route's targets: retries each one while it has
 * attempts left, fails over on model-level errors and exhausted attempts, and
 * returns fatal responses (or the final failure) verbatim so the client sees
 * the upstream's real error.
 */
export async function fetchWithFailover(
  options: FetchWithFailoverOptions,
): Promise<FailoverResult> {
  const { route, requestFor } = options;
  const breakers = options.breakers ?? new TargetBreakers();
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const attempts: RouteAttempt[] = [];
  let lastFailure: { response: Response } | { error: unknown } | undefined;

  for (const target of route.targets) {
    const upstreamModel = target.upstreamModel ?? route.model.slug;
    const key = breakerKey(route, target);
    if (breakers.isOpen(key)) {
      attempts.push({ upstreamModel, outcome: "breaker-open" });
      continue;
    }
    let exhausted = false;
    for (let attempt = 0; attempt < target.attempts; attempt++) {
      if (attempt > 0) {
        await sleep(backoffDelayMs(route.retry.backoffMs, attempt - 1));
      }
      const { url, init } = requestFor(target);
      const startedAt = performance.now();
      const durationMs = () => Math.round(performance.now() - startedAt);
      let response: Response;
      try {
        response = await fetchImpl(url, init);
      } catch (error) {
        attempts.push({ upstreamModel, outcome: "network-error", durationMs: durationMs() });
        lastFailure = { error };
        if (attempt + 1 >= target.attempts) exhausted = true;
        continue;
      }
      if (response.ok) {
        const resolved = await resolveEventStreamResponse(response);
        if (resolved.kind === "ok") {
          breakers.recordSuccess(key);
          attempts.push({
            upstreamModel,
            outcome: "served",
            status: response.status,
            durationMs: durationMs(),
          });
          return { response: resolved.response, attempts, servedBy: upstreamModel };
        }
        response = new Response(
          JSON.stringify({
            error: { code: "rate_limit_exceeded", message: "rate_limit_exceeded" },
          }),
          { status: resolved.status, headers: { "content-type": "application/json" } },
        );
      }
      const failureClass = classifyHttpFailure(response.status, route.retry.onStatus);
      if (failureClass === "fatal") {
        attempts.push({
          upstreamModel,
          outcome: failureClass,
          status: response.status,
          durationMs: durationMs(),
        });
        return { response, attempts };
      }
      if (failureClass === "failover") {
        attempts.push({
          upstreamModel,
          outcome: failureClass,
          status: response.status,
          durationMs: durationMs(),
        });
        lastFailure = { response };
        exhausted = true;
        break;
      }
      // retry: drain the error body so the connection is reusable, and keep a
      // replayable copy in case every later target is unavailable too
      const body = new Uint8Array(await response.arrayBuffer());
      attempts.push({
        upstreamModel,
        outcome: failureClass,
        status: response.status,
        durationMs: durationMs(),
      });
      lastFailure = {
        response: new Response(body, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        }),
      };
      if (attempt + 1 >= target.attempts) {
        exhausted = true;
      }
    }
    if (exhausted) {
      breakers.recordFailureEpisode(key, route.retry.breaker);
    }
  }

  if (lastFailure !== undefined && "response" in lastFailure) {
    return { response: lastFailure.response, attempts };
  }
  const detail =
    lastFailure !== undefined && "error" in lastFailure && lastFailure.error instanceof Error
      ? lastFailure.error.message
      : "all route targets unavailable";
  return {
    response: new Response(`model route ${route.model.slug} failed: ${detail}`, {
      status: 502,
      headers: { "content-type": "text/plain; charset=utf-8" },
    }),
    attempts,
  };
}
