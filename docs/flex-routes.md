# Flex routes

OpenAI **flex processing** is the same model at Batch API prices: half of
standard input, cached-input, cache-write, and output rates, in exchange for
slower responses and occasional `429` when flex capacity is gone. Official
notes: [Flex processing](https://developers.openai.com/api/docs/guides/flex-processing)
and [Pricing](https://developers.openai.com/api/docs/pricing) (the Batch / Flex
table is half the Standard table).

This proxy does not send `service_tier: "flex"`. It advertises a `-flex` slug
to Codex and routes that slug at an HTTP gateway to an `*-flex` upstream model,
then to the regular model if flex fails.

## Why use it

A long Codex turn is mostly repeated prefix (instructions, tools, history).
Flex halves every token class, including cached reads. When flex serves, you
keep both discounts: Batch-rate tokens **and** prompt cache.

Typical fit:

- Interactive agent work that can wait a bit longer than standard.
- High-volume or overnight sessions where latency is less important than cost.
- Evals and enrichment — OpenAI’s stated flex audience.

Poor fit:

- Turns that must complete quickly or never 429.
- Workloads that already cache heavily **and** fail over often (see below).

## How to configure a flex-preferred route

Advertise a distinct slug (`gpt-5.6-luna-flex`) so Codex can still pick the
standard model when you want it. Put the flex upstream first, the regular
model second, and give flex a few retries — flex’s usual failure is `429`
resource unavailable, which is free (OpenAI does not charge that attempt).

```json
{
  "authorization_env": "OPENAI_API_KEY",
  "enabled": true,
  "transport": "http",
  "upstream": "https://ai-gateway.example/openai/v1",
  "model": {
    "slug": "gpt-5.6-luna-flex",
    "template_slug": "gpt-5.6-luna",
    "display_name": "GPT-5.6 Luna (flex)",
    "description": "Luna via flex, then standard if flex is unavailable.",
    "priority": 1
  },
  "targets": [
    { "upstream_model": "openai.gpt-5.6-luna-flex", "attempts": 3 },
    { "upstream_model": "openai.gpt-5.6-luna" }
  ]
}
```

Default retry statuses already include `429` and the 5xx set. The gateway
sometimes accepts the request with HTTP 200 and then emits
`rate_limit_exceeded` on the SSE stream (“We're currently processing too many
requests”). That in-stream error is treated as a `429`: the same target is
retried, then the route fails over to the regular model. Those attempts count
as failures on the flex target in Model Routes stats, not as serves.

A circuit breaker skips a target that has just exhausted its attempts, so the
next request can go straight to standard instead of waiting on a dead flex
pool.

Then ask Codex for the advertised slug:

```sh
codex exec --model gpt-5.6-luna-flex …
```

## Prompt cache does not survive a tier switch

Discovered while measuring fallbacks on these routes (2026-09-11).

OpenAI prompt-cache reuse requires the same model, exact prefix, cache key,
**and** effective service tier. Their diagnostics classify both
`service_tier_changed` and `model_changed` as cache misses
([Prompt cache diagnostics](https://developers.openai.com/api/docs/guides/prompt-caching/diagnostics)).

A flex → standard failover changes both: the gateway slug
(`openai.gpt-5.6-luna-flex` → `openai.gpt-5.6-luna`) and the tier. The
fallback request therefore pays **uncached standard input** for the whole
prompt, plus standard output. The flex prefix is not reused.

That can erase the flex savings on that turn. A large, previously cached
conversation that fails over may cost more than the same turn served on
standard with a warm cache. Subsequent standard turns can rebuild a standard
cache; they still do not share entries with flex.

Stay on one tier for a conversation when cache hit rate matters. Use
flex-preferred when most requests actually stay on flex.

## How the proxy measures this

Routing counters persist in `.agent-context-trimmer/stats.json` (reset from
the Model routes page). After each served completion the proxy records
`usage.input_tokens` and `usage.input_tokens_details.cached_tokens`.

On a route card:

| Field            | Meaning                                                 |
| ---------------- | ------------------------------------------------------- |
| `errors %`       | Failed requests (route) or failed attempts (per target) |
| `retry a/b (c%)` | Requests that retried this target and then served on it |
| `fallbacks`      | Requests served by a later target than the first tried  |
| `cache`          | Cached / input tokens across served completions         |
| `fallback cache` | Same ratio, only for failover serves                    |

A fallback cache rate far below the first-target cache rate is the
tier-switch miss in numbers. Samples start on completions after this
instrumentation shipped; older counters are not backfilled.
