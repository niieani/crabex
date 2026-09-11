import { describe, expect, it } from "vite-plus/test";

import {
  backoffDelayMs,
  classifyHttpFailure,
  fetchWithFailover,
  TargetBreakers,
} from "./failover.ts";
import { modelRouteFromConfig, type ModelRoute } from "./model-routes.ts";

const noSleep = () => Promise.resolve();

function astraRoute(): ModelRoute {
  return modelRouteFromConfig({
    authorization_env: "OPENAI_API_KEY",
    model: {
      description: "GPT-6 Astra via the AI gateway",
      display_name: "GPT-6 Astra",
      priority: 1,
      slug: "gpt-6-astra",
      template_slug: "gpt-6-astra",
    },
    upstream: "https://gateway.test/openai/v1",
    transport: "http",
    targets: [
      { upstream_model: "openai.gpt-6-astra-flex", attempts: 3 },
      { upstream_model: "openai.gpt-6-astra" },
    ],
    retry: { on_status: [429], backoff_ms: [0], breaker: { failures: 2, cooldown_ms: 60_000 } },
  });
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function fakeFetch(
  plan: Record<string, Array<Response | (() => Response)>>,
): typeof fetch & { seen: string[] } {
  const seen: string[] = [];
  const impl = async (...args: Parameters<typeof fetch>) => {
    const model = JSON.parse(args[1]?.body as string) as { model: string };
    seen.push(model.model);
    const next = plan[model.model]?.shift();
    if (next === undefined) throw new Error(`unexpected request for ${model.model}`);
    return typeof next === "function" ? next() : next;
  };
  return Object.assign(impl, { seen }) as typeof fetch & { seen: string[] };
}

describe("classifyHttpFailure", () => {
  it("classifies retry, failover, and fatal statuses", () => {
    expect(classifyHttpFailure(429, [429])).toBe("retry");
    expect(classifyHttpFailure(503, [429])).toBe("fatal");
    expect(classifyHttpFailure(503, [429, 503])).toBe("retry");
    expect(classifyHttpFailure(404, [429])).toBe("failover");
    expect(classifyHttpFailure(403, [429])).toBe("failover");
    expect(classifyHttpFailure(400, [429])).toBe("fatal");
    expect(classifyHttpFailure(401, [429])).toBe("fatal");
  });
});

describe("backoffDelayMs", () => {
  it("stays within the configured ceiling and clamps to the last value", () => {
    for (let i = 0; i < 100; i++) {
      expect(backoffDelayMs([500, 2000], 0)).toBeLessThanOrEqual(500);
      expect(backoffDelayMs([500, 2000], 1)).toBeLessThanOrEqual(2000);
      expect(backoffDelayMs([500, 2000], 9)).toBeLessThanOrEqual(2000);
    }
    expect(backoffDelayMs([0], 3)).toBe(0);
  });
});

describe("TargetBreakers", () => {
  it("opens after the configured consecutive episodes and cools down", () => {
    let now = 1_000;
    const breakers = new TargetBreakers(() => now);
    const policy = { failures: 2, cooldownMs: 60_000 };

    breakers.recordFailureEpisode("a", policy);
    expect(breakers.isOpen("a")).toBe(false);
    breakers.recordFailureEpisode("a", policy);
    expect(breakers.isOpen("a")).toBe(true);

    now += 59_999;
    expect(breakers.isOpen("a")).toBe(true);
    now += 1;
    expect(breakers.isOpen("a")).toBe(false); // half-open probe allowed

    breakers.recordFailureEpisode("a", policy);
    breakers.recordFailureEpisode("a", policy);
    expect(breakers.isOpen("a")).toBe(true);
    breakers.recordSuccess("a");
    expect(breakers.isOpen("a")).toBe(false);
  });
});

describe("fetchWithFailover", () => {
  it("serves from the first target when it succeeds", async () => {
    const fetchImpl = fakeFetch({ "openai.gpt-6-astra-flex": [jsonResponse(200, { ok: true })] });

    const result = await fetchWithFailover({
      route: astraRoute(),
      fetchImpl,
      sleep: noSleep,
      requestFor: (target) => ({
        url: new URL("https://gateway.test/openai/v1/responses"),
        init: { method: "POST", body: JSON.stringify({ model: target.upstreamModel }) },
      }),
    });

    expect(result.response.status).toBe(200);
    expect(result.servedBy).toBe("openai.gpt-6-astra-flex");
    expect(result.attempts).toEqual([
      {
        upstreamModel: "openai.gpt-6-astra-flex",
        outcome: "served",
        status: 200,
        durationMs: expect.any(Number),
      },
    ]);
  });

  it("retries a 429ing flex target with backoff before serving", async () => {
    const fetchImpl = fakeFetch({
      "openai.gpt-6-astra-flex": [
        jsonResponse(429, { error: "resource unavailable" }),
        jsonResponse(429, { error: "resource unavailable" }),
        jsonResponse(200, { ok: true }),
      ],
    });

    const result = await fetchWithFailover({
      route: astraRoute(),
      fetchImpl,
      sleep: noSleep,
      requestFor: (target) => ({
        url: new URL("https://gateway.test/openai/v1/responses"),
        init: { method: "POST", body: JSON.stringify({ model: target.upstreamModel }) },
      }),
    });

    expect(result.response.status).toBe(200);
    expect(fetchImpl.seen).toEqual([
      "openai.gpt-6-astra-flex",
      "openai.gpt-6-astra-flex",
      "openai.gpt-6-astra-flex",
    ]);
    expect(result.attempts.map((attempt) => attempt.outcome)).toEqual(["retry", "retry", "served"]);
  });

  it("fails over to the regular model when flex exhausts its attempts", async () => {
    const fetchImpl = fakeFetch({
      "openai.gpt-6-astra-flex": [
        jsonResponse(429, {}),
        jsonResponse(429, {}),
        jsonResponse(429, {}),
      ],
      "openai.gpt-6-astra": [jsonResponse(200, { ok: "standard" })],
    });

    const result = await fetchWithFailover({
      route: astraRoute(),
      fetchImpl,
      sleep: noSleep,
      requestFor: (target) => ({
        url: new URL("https://gateway.test/openai/v1/responses"),
        init: { method: "POST", body: JSON.stringify({ model: target.upstreamModel }) },
      }),
    });

    expect(result.response.status).toBe(200);
    expect(result.servedBy).toBe("openai.gpt-6-astra");
    expect(fetchImpl.seen).toEqual([
      "openai.gpt-6-astra-flex",
      "openai.gpt-6-astra-flex",
      "openai.gpt-6-astra-flex",
      "openai.gpt-6-astra",
    ]);
  });

  it("fails over immediately on 404 without spending retries", async () => {
    const fetchImpl = fakeFetch({
      "openai.gpt-6-astra-flex": [jsonResponse(404, { error: "no such model" })],
      "openai.gpt-6-astra": [jsonResponse(200, { ok: true })],
    });

    const result = await fetchWithFailover({
      route: astraRoute(),
      fetchImpl,
      sleep: noSleep,
      requestFor: (target) => ({
        url: new URL("https://gateway.test/openai/v1/responses"),
        init: { method: "POST", body: JSON.stringify({ model: target.upstreamModel }) },
      }),
    });

    expect(result.servedBy).toBe("openai.gpt-6-astra");
    expect(fetchImpl.seen).toEqual(["openai.gpt-6-astra-flex", "openai.gpt-6-astra"]);
    expect(result.attempts[0]?.outcome).toBe("failover");
  });

  it("returns fatal responses verbatim without trying further targets", async () => {
    const fetchImpl = fakeFetch({
      "openai.gpt-6-astra-flex": [jsonResponse(400, { error: "bad request" })],
    });

    const result = await fetchWithFailover({
      route: astraRoute(),
      fetchImpl,
      sleep: noSleep,
      requestFor: (target) => ({
        url: new URL("https://gateway.test/openai/v1/responses"),
        init: { method: "POST", body: JSON.stringify({ model: target.upstreamModel }) },
      }),
    });

    expect(result.response.status).toBe(400);
    expect(await result.response.json()).toEqual({ error: "bad request" });
    expect(fetchImpl.seen).toEqual(["openai.gpt-6-astra-flex"]);
  });

  it("forwards the last upstream error when every target is exhausted", async () => {
    const fetchImpl = fakeFetch({
      "openai.gpt-6-astra-flex": [
        jsonResponse(429, {}),
        jsonResponse(429, {}),
        jsonResponse(429, {}),
      ],
      "openai.gpt-6-astra": [jsonResponse(503, { error: "overloaded" })],
    });

    const result = await fetchWithFailover({
      route: astraRoute(),
      fetchImpl,
      sleep: noSleep,
      requestFor: (target) => ({
        url: new URL("https://gateway.test/openai/v1/responses"),
        init: { method: "POST", body: JSON.stringify({ model: target.upstreamModel }) },
      }),
    });

    expect(result.response.status).toBe(503);
    expect(await result.response.json()).toEqual({ error: "overloaded" });
  });

  it("skips a target whose breaker is open", async () => {
    const breakers = new TargetBreakers();
    const route = astraRoute();
    breakers.recordFailureEpisode("gpt-6-astra::openai.gpt-6-astra-flex", route.retry.breaker);
    breakers.recordFailureEpisode("gpt-6-astra::openai.gpt-6-astra-flex", route.retry.breaker);
    expect(breakers.isOpen("gpt-6-astra::openai.gpt-6-astra-flex")).toBe(true);

    const fetchImpl = fakeFetch({ "openai.gpt-6-astra": [jsonResponse(200, { ok: true })] });
    const result = await fetchWithFailover({
      route,
      breakers,
      fetchImpl,
      sleep: noSleep,
      requestFor: (target) => ({
        url: new URL("https://gateway.test/openai/v1/responses"),
        init: { method: "POST", body: JSON.stringify({ model: target.upstreamModel }) },
      }),
    });

    expect(result.servedBy).toBe("openai.gpt-6-astra");
    expect(fetchImpl.seen).toEqual(["openai.gpt-6-astra"]);
    expect(result.attempts[0]).toEqual({
      upstreamModel: "openai.gpt-6-astra-flex",
      outcome: "breaker-open",
    });
  });

  it("synthesizes a 502 when every target fails at the network level", async () => {
    const fetchImpl = (async () => {
      throw new Error("connection refused");
    }) as unknown as typeof fetch;

    const result = await fetchWithFailover({
      route: astraRoute(),
      fetchImpl,
      sleep: noSleep,
      requestFor: (target) => ({
        url: new URL("https://gateway.test/openai/v1/responses"),
        init: { method: "POST", body: JSON.stringify({ model: target.upstreamModel }) },
      }),
    });

    expect(result.response.status).toBe(502);
    expect(await result.response.text()).toContain("connection refused");
    expect(result.attempts).toHaveLength(4);
  });
});
