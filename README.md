# Agent Context Trimmer

Local, OAuth-preserving recorder for Codex Responses traffic. It replaces only
the destination origin; request paths, payloads, OAuth/account headers, streaming
responses, and WebSocket messages pass through to the ChatGPT Codex backend.

## Run

```sh
vp install
vp run dev
```

The default listener is `http://127.0.0.1:8765`. Captures are append-only NDJSON
files under `.agent-context-trimmer/captures` with mode `0600`. Headers are never
included in captures.

Configure an opt-in Codex profile:

```toml
# ~/.codex/audit.config.toml
openai_base_url = "http://127.0.0.1:8765/backend-api/codex"
```

Then start Codex with the existing ChatGPT login:

```sh
codex --profile audit
```

The proxy forwards to `https://chatgpt.com` by default. No API key or
CLIProxyAPI is involved.

## Commands

```text
agent-context-trimmer proxy \
  --listen 127.0.0.1:8765 \
  --upstream https://chatgpt.com \
  --captures .agent-context-trimmer/captures
```

## Development

```sh
vp run test
vp check
vp run build
```
