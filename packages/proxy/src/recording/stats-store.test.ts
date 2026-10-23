import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vite-plus/test";

import { StatsStore } from "./stats-store.ts";

describe("stats store", () => {
  it("aggregates hit, miss, and error executions by transformation", async () => {
    const store = await StatsStore.open(await temporaryPath());
    const first = new Date(1000).toISOString();
    const second = new Date(2000).toISOString();

    store.recordTransformations(
      [
        { transformationId: "trim", status: "hit", matchCount: 3 },
        { transformationId: "optional", status: "miss", matchCount: 0 },
      ],
      first,
    );
    store.recordTransformations(
      [
        { transformationId: "trim", status: "miss", matchCount: 0 },
        { transformationId: "optional", status: "error", matchCount: 0, error: "bad" },
      ],
      second,
    );

    expect(store.transformationTelemetry()).toEqual([
      {
        transformationId: "optional",
        hits: 0,
        misses: 1,
        errors: 1,
        matchCount: 0,
        lastRunAt: second,
      },
      {
        transformationId: "trim",
        hits: 1,
        misses: 1,
        errors: 0,
        matchCount: 3,
        lastRunAt: second,
      },
    ]);
  });

  it("aggregates routing decisions by action and route", async () => {
    const store = await StatsStore.open(await temporaryPath());
    const first = new Date(1000).toISOString();
    const second = new Date(2000).toISOString();
    const routed = {
      action: "routed" as const,
      routeSlugs: ["kimi-k3"],
      upstream: "http://127.0.0.1:8317",
      requestedModel: "kimi-k3",
      upstreamModel: "moonshot-kimi-k3",
    };

    store.recordRouting(routed, first);
    store.recordRouting(routed, second);
    store.recordRouting({ action: "bundle-override" }, first);
    store.recordRouting({ action: "models-advertised", routeSlugs: ["kimi-k3"] }, second);

    expect(store.routingTelemetry()).toEqual([
      { action: "bundle-override", count: 1, lastSeenAt: first },
      { action: "models-advertised", count: 1, lastSeenAt: second },
      { action: "routed", routeSlug: "kimi-k3", count: 2, lastSeenAt: second },
    ]);
  });

  it("tracks per-target attempts, outcomes, and latency for failover routes", async () => {
    const store = await StatsStore.open(await temporaryPath());
    const ts = new Date(1000).toISOString();

    store.recordRouting(
      {
        action: "routed",
        routeSlugs: ["gpt-6-astra"],
        attempts: [
          {
            upstreamModel: "openai.gpt-6-astra-flex",
            outcome: "retry",
            status: 429,
            durationMs: 100,
          },
          {
            upstreamModel: "openai.gpt-6-astra-flex",
            outcome: "served",
            status: 200,
            durationMs: 300,
          },
        ],
      },
      ts,
    );
    store.recordRouting(
      {
        action: "routed",
        routeSlugs: ["gpt-6-astra"],
        attempts: [
          {
            upstreamModel: "openai.gpt-6-astra-flex",
            outcome: "fatal",
            status: 400,
            durationMs: 60,
          },
        ],
      },
      ts,
    );

    expect(store.routingTelemetry()).toEqual([
      {
        action: "routed",
        routeSlug: "gpt-6-astra",
        count: 2,
        lastSeenAt: ts,
        served: 1,
        failed: 1,
        failovers: 0,
        errorRate: 50,
        avgLatencyMs: 230,
        targets: {
          "openai.gpt-6-astra-flex": {
            attempts: 3,
            served: 1,
            failed: 2,
            retries: 1,
            retriedRequests: 1,
            retryRecoveries: 1,
            failovers: 0,
            totalLatencyMs: 460,
            lastStatus: 400,
            lastSeenAt: ts,
            avgLatencyMs: 153,
            errorRate: 67,
            retrySuccessRate: 100,
          },
        },
      },
    ]);
  });

  it("counts flex 429 retries toward target error rate after a standard failover", async () => {
    const store = await StatsStore.open(await temporaryPath());
    const ts = new Date(1000).toISOString();
    store.recordRouting(
      {
        action: "routed",
        routeSlugs: ["gpt-6-astra"],
        upstreamModel: "openai.gpt-6-astra",
        attempts: [
          {
            upstreamModel: "openai.gpt-6-astra-flex",
            outcome: "retry",
            status: 429,
            durationMs: 40,
          },
          {
            upstreamModel: "openai.gpt-6-astra-flex",
            outcome: "retry",
            status: 429,
            durationMs: 40,
          },
          { upstreamModel: "openai.gpt-6-astra", outcome: "served", status: 200, durationMs: 80 },
        ],
      },
      ts,
    );

    const entry = store.routingTelemetry()[0];
    expect(entry).toMatchObject({
      served: 1,
      failed: 0,
      failovers: 1,
      errorRate: 0,
      targets: {
        "openai.gpt-6-astra-flex": { attempts: 2, served: 0, failed: 2, errorRate: 100 },
        "openai.gpt-6-astra": { attempts: 1, served: 1, failed: 0, errorRate: 0 },
      },
    });
  });

  it("tracks fallback serves and prompt-cache usage on first-target vs fallback", async () => {
    const store = await StatsStore.open(await temporaryPath());
    const ts = new Date(1000).toISOString();
    const fallbackRouting = {
      action: "routed" as const,
      routeSlugs: ["gpt-5.6-luna-flex"],
      upstreamModel: "openai.gpt-5.6-luna",
      attempts: [
        {
          upstreamModel: "openai.gpt-5.6-luna-flex",
          outcome: "failover" as const,
          status: 429,
          durationMs: 80,
        },
        {
          upstreamModel: "openai.gpt-5.6-luna",
          outcome: "served" as const,
          status: 200,
          durationMs: 400,
        },
      ],
    };
    const firstHitRouting = {
      action: "routed" as const,
      routeSlugs: ["gpt-5.6-luna-flex"],
      upstreamModel: "openai.gpt-5.6-luna-flex",
      attempts: [
        {
          upstreamModel: "openai.gpt-5.6-luna-flex",
          outcome: "served" as const,
          status: 200,
          durationMs: 200,
        },
      ],
    };

    store.recordRouting(fallbackRouting, ts);
    store.recordUsage(fallbackRouting, { inputTokens: 20_000, cachedTokens: 0 }, ts);
    store.recordRouting(firstHitRouting, ts);
    store.recordUsage(firstHitRouting, { inputTokens: 20_000, cachedTokens: 16_000 }, ts);

    const entry = store.routingTelemetry().find((item) => item.routeSlug === "gpt-5.6-luna-flex");
    expect(entry).toMatchObject({
      served: 2,
      failed: 0,
      failovers: 1,
      errorRate: 0,
      cacheHitRate: 40,
      fallbackCacheHitRate: 0,
      cache: { samples: 2, inputTokens: 40_000, cachedTokens: 16_000 },
      fallbackCache: { samples: 1, inputTokens: 20_000, cachedTokens: 0 },
    });
    expect(entry?.targets?.["openai.gpt-5.6-luna-flex"]).toMatchObject({
      attempts: 2,
      served: 1,
      failed: 1,
      failovers: 1,
      errorRate: 50,
      cacheHitRate: 80,
      cache: { samples: 1, inputTokens: 20_000, cachedTokens: 16_000 },
    });
    expect(entry?.targets?.["openai.gpt-5.6-luna"]).toMatchObject({
      attempts: 1,
      served: 1,
      failed: 0,
      errorRate: 0,
      cacheHitRate: 0,
      cache: { samples: 1, inputTokens: 20_000, cachedTokens: 0 },
    });
  });

  it("counts exhausted retries separately from recoveries", async () => {
    const store = await StatsStore.open(await temporaryPath());
    const ts = new Date(1000).toISOString();
    store.recordRouting(
      {
        action: "routed",
        routeSlugs: ["gpt-6-astra"],
        attempts: [
          { upstreamModel: "flex", outcome: "retry", status: 429, durationMs: 10 },
          { upstreamModel: "flex", outcome: "failover", status: 503, durationMs: 10 },
          { upstreamModel: "regular", outcome: "served", status: 200, durationMs: 50 },
        ],
      },
      ts,
    );

    const flex = store.routingTelemetry()[0]?.targets?.flex;
    expect(flex).toMatchObject({
      retries: 1,
      retriedRequests: 1,
      retryRecoveries: 0,
      failovers: 1,
      retrySuccessRate: 0,
      errorRate: 100,
    });
  });

  it("keeps a daily usage ledger per served model through counter resets", async () => {
    const path = await temporaryPath();
    const store = await StatsStore.open(path);
    const routed = {
      action: "routed" as const,
      routeSlugs: ["kimi-k3"],
      upstreamModel: "moonshot-kimi-k3",
    };
    const usage = { inputTokens: 100, cachedTokens: 40, outputTokens: 10, reasoningTokens: 4 };
    store.recordUsage(undefined, usage, "2026-10-01T10:00:00.000Z", "gpt-6-sol");
    store.recordUsage(undefined, usage, "2026-10-01T23:00:00.000Z", "gpt-6-sol");
    store.recordUsage(routed, { inputTokens: 5, cachedTokens: 0 }, "2026-10-02T01:00:00.000Z");

    await store.reset();
    const ledger = (await StatsStore.open(path)).usageLedger();

    expect(ledger).toEqual({
      "2026-10-01": {
        "gpt-6-sol": {
          model: "gpt-6-sol",
          responses: 2,
          inputTokens: 200,
          cachedTokens: 80,
          outputTokens: 20,
          reasoningTokens: 8,
        },
      },
      "2026-10-02": {
        "kimi-k3:moonshot-kimi-k3": {
          model: "moonshot-kimi-k3",
          routeSlug: "kimi-k3",
          responses: 1,
          inputTokens: 5,
          cachedTokens: 0,
          outputTokens: 0,
          reasoningTokens: 0,
        },
      },
    });
  });

  it("persists across restarts and resets counters", async () => {
    const path = await temporaryPath();
    const store = await StatsStore.open(path);
    const ts = new Date(1000).toISOString();
    store.recordTransformations([{ transformationId: "trim", status: "hit", matchCount: 2 }], ts);
    store.recordRouting({ action: "bundle-override" }, ts);
    await store.flush();

    const persisted = JSON.parse(await readFile(path, "utf8")) as {
      transformations: Record<string, unknown>;
      actions: Record<string, unknown>;
    };
    expect(Object.keys(persisted.transformations)).toEqual(["trim"]);
    expect(Object.keys(persisted.actions)).toEqual(["bundle-override"]);

    const reopened = await StatsStore.open(path);
    expect(reopened.transformationTelemetry()).toHaveLength(1);
    expect(reopened.routingTelemetry()).toHaveLength(1);

    await reopened.reset();
    expect(reopened.transformationTelemetry()).toEqual([]);
    expect(reopened.routingTelemetry()).toEqual([]);
    const afterReset = JSON.parse(await readFile(path, "utf8")) as {
      transformations: Record<string, unknown>;
    };
    expect(afterReset.transformations).toEqual({});
  });

  it("tolerates a missing or corrupt stats file", async () => {
    const missing = await StatsStore.open(await temporaryPath());
    expect(missing.routingTelemetry()).toEqual([]);

    const path = await temporaryPath();
    await (await import("node:fs/promises")).writeFile(path, "not json");
    const corrupt = await StatsStore.open(path);
    expect(corrupt.routingTelemetry()).toEqual([]);
  });
});

async function temporaryPath(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), "act-stats-")), "stats.json");
}
