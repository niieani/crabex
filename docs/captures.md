# Captures and Probes

Crabex records each request chain it proxies so you can see exactly what Codex
sent to the model: instructions, tools, history, and how your transformations
changed them. Open the UI (`http://127.0.0.1:8765` by default) to browse them.

## What is stored

Captures are append-only NDJSON files under `.crabex/captures` with mode `0600`.
Request headers are never recorded.

New captures retain full payloads only through the first ordinary user message
in a Probe. Later client and upstream events retain metadata—protocol fields,
message roles and stable harness classifications, payload size, usage, and
transformation executions—but no raw payload or effective payload.
Harness-injected messages such as `<environment_context>` do not end the
full-capture window. Existing capture files are not rewritten. To inspect
captures from another directory, start the proxy with an explicit
`--captures <dir>`.

The Captures page uses a lightweight live index and fetches full content only
when opened. Search by model, project, or session; filter by harness; pause live
updates; or step between captures. **Preview rules** applies the current
transformation set on demand. The retained catalog keeps the newest three
snapshots per model/project/harness combination, up to 50 overall; raw captures
are unaffected.

## Run a smoke Probe

A Probe is a trivial one-turn request whose purpose is to reveal the initial
context supplied by the harness. With Codex pointed at Crabex:

```sh
codex exec \
  --ephemeral \
  --model gpt-5.6-luna \
  -c 'model_reasoning_effort="low"' \
  'Reply with exactly: audit-ok'
```

Expected model output: `audit-ok`. The UI then shows the linked prewarm and
inference requests, context parts, tools, token estimates, and
original/effective transformation results.

Codex subprocesses launched from inside Codex Desktop can inherit Desktop
originator identity. Trust the harness shown in the capture; run the Probe from
an independent terminal when specifically testing TUI-scoped transformations.

For the inspector's design and vocabulary, see
[context-inspector.md](context-inspector.md) and [CONTEXT.md](../CONTEXT.md).
