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
        avgLatencyMs: 230,
        targets: {
          "openai.gpt-6-astra-flex": {
            attempts: 3,
            served: 1,
            failed: 2,
            totalLatencyMs: 460,
            lastStatus: 400,
            lastSeenAt: ts,
            avgLatencyMs: 153,
          },
        },
      },
    ]);
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
