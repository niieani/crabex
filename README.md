# Agent Context Trimmer

Local, OAuth-preserving recorder for Codex Responses traffic. It replaces only
the destination origin; request paths, payloads, OAuth/account headers, streaming
responses, and WebSocket messages pass through to the ChatGPT Codex backend.

## Run

```sh
vp install
vp run dev:proxy
vp run dev:ui
```

The default listener is `http://127.0.0.1:8765`. Captures are append-only NDJSON
files under `.agent-context-trimmer/captures` with mode `0600`. Headers are never
included in captures. The UI is served by Vite at `http://127.0.0.1:5173` and
refreshes automatically as completed Probes arrive.

The proxy must be running before starting Codex with the audit profile.

## Install the Codex audit profile

Create `~/.codex/audit.config.toml`:

```toml
openai_base_url = "http://127.0.0.1:8765/backend-api/codex"
```

This profile layers only the proxy destination onto the normal Codex
configuration, preserving the existing ChatGPT subscription/OAuth login. No API
key or CLIProxyAPI is involved.

## Run an interactive audit

```sh
codex --profile audit
```

The proxy forwards to `https://chatgpt.com`, records the request chain, and
applies enabled transformations before forwarding each request.

## Run a smoke Probe

A Probe should be a trivial one-turn request whose purpose is to reveal the
initial context supplied by the harness:

```sh
codex exec \
  --profile audit \
  --ephemeral \
  --model gpt-5.6-luna \
  -c 'model_reasoning_effort="low"' \
  'Reply with exactly: audit-ok'
```

Expected model output: `audit-ok`. Open `http://127.0.0.1:5173` to inspect the
linked prewarm and inference requests, context parts, tools, token estimates,
and original/effective transformation results.

Codex subprocesses launched from inside Codex Desktop can inherit Desktop
originator identity. Trust the harness shown in the capture; run the Probe from
an independent terminal when specifically testing TUI-scoped transformations.

Captures persist under `.agent-context-trimmer/captures`. To inspect captures
from another directory, start the proxy with an explicit `--captures <dir>`.

## Commands

```text
agent-context-trimmer proxy \
  --listen 127.0.0.1:8765 \
  --upstream https://chatgpt.com \
  --captures .agent-context-trimmer/captures \
  --transformations .agent-context-trimmer/transformations.json \
  --project agent-context-trimmer
```

## Development

```sh
vp run test
vp check
vp run build
```

## Workspace layout

- `packages/proxy`: Bun server and CLI.
- `packages/ui`: React and Tailwind context inspector.
