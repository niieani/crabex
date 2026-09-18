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

## Apps with a proxied ChatGPT base URL

When `chatgpt_base_url` points at this proxy, Codex also sends Apps MCP traffic
here. Codex withholds its ambient ChatGPT login from a localhost MCP endpoint,
which can leave Slack, Drive, and other native Apps tools unavailable with an
upstream `451 no_biscuit_no_service` response.

For a single-account local setup, credential reuse is enabled by default:

```sh
vp run dev:proxy
```

Keep both proxy settings in Codex:

```toml
openai_base_url = "http://127.0.0.1:8765/backend-api/codex"
chatgpt_base_url = "http://127.0.0.1:8765/backend-api"
```

Use **Codex setup → Proxy settings → Apps authentication relay** to toggle it.
Changes take effect immediately, clear cached credentials when disabling, and
persist in `.agent-context-trimmer/config.json`:

```json
{
  "version": 1,
  "appsAuthRelay": false
}
```

An absent config file or omitted `appsAuthRelay` field defaults to `true`.
Use `--config <file>` for another settings file. Direct file edits are read on
startup; changes through the UI apply live. `--no-apps-auth-relay` and
`--apps-auth-relay` override the file for that process and lock the UI toggle
until the proxy restarts without the override. Proxy settings live separately
from Codex's `config.toml` and never contain credentials.

The relay remembers the bearer token and account header from authenticated
`/backend-api/` requests, including config-bundle fetches answered locally and
WebSocket handshakes. It adds them only to unauthenticated requests to
`/backend-api/ps/mcp`, forwarding to the configured upstream without following
redirects. Explicit Apps authorization is preserved. Credentials stay in memory
and are never added to captures or persisted configuration. Config-bundle
overrides, model routing, and context transformations continue to work.

Limitations:

- The relay requires a loopback listener; use `--no-apps-auth-relay` when binding
  the proxy to a non-loopback address. Other local processes
  that can reach that listener can use its Apps endpoint with the cached login;
  use it only on a trusted, single-user machine.
- One ChatGPT account per proxy process is supported. If authenticated traffic
  identifies a second account, credential reuse stops with a 503. Restart the
  proxy after an account switch; simultaneous accounts are unsupported.
- Apps can arrive first. The relay waits up to five seconds for authenticated
  Codex traffic, then returns a clear 503 with `Retry-After: 1`. A retry or a new
  Codex session may be needed once credentials have arrived.
- Codex owns login and token refresh. The relay learns new tokens only from
  subsequent authenticated requests. It does not refresh tokens or replay failed
  tool calls, and cannot detect logout until it observes new traffic or restarts.
- Account headers identify the supported workspace/account, not an individual
  login within that account. Different users sharing one workspace are also
  unsupported. Stop the proxy when ending the authenticated session.
- Connector permissions and approval prompts still apply. The relay repairs
  authentication transport; it does not change tool approval policies.

The proxy disables Bun's HTTP idle timer for forwarded requests. ChatGPT's
connector directory can take tens of seconds before returning headers, and MCP
streams can pause; the default idle timer otherwise resets the local connection
and makes `app/list` fail with `Failed to send request`. Local UI/API requests
retain the normal timeout. Upstream and client deadlines still apply.

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

Captures persist under `.agent-context-trimmer/captures`. New captures retain
full payloads only through the first ordinary user message in a Probe. Later
client and upstream events retain metadata—protocol fields, message roles and
stable harness classifications, payload size, usage, and transformation
executions—but no raw payload or effective payload. Harness-injected messages
such as `<environment_context>` do not end the full-capture window. Existing
capture files are not rewritten. To inspect captures from another directory,
start the proxy with an explicit `--captures <dir>`.

## Commands

```text
agent-context-trimmer proxy \
  --listen 127.0.0.1:8765 \
  --upstream https://chatgpt.com \
  --captures .agent-context-trimmer/captures \
  --transformations .agent-context-trimmer/transformations.json \
  --model-routes .agent-context-trimmer/model-routes.json \
  --config-bundle .agent-context-trimmer/config-bundle.json \
  --codex-config ~/.codex/config.toml \
  --project agent-context-trimmer
```

## Development

```sh
vp run test
vp check
vp run build
```

## Flex routes

Advertise a `-flex` slug and fail over to the regular model when flex is
unavailable. Flex is half-price (Batch rates) but slower, and a flex →
standard fallback drops the prompt cache. See [docs/flex-routes.md](docs/flex-routes.md).

## Workspace layout

- `packages/proxy`: Bun server and CLI.
- `packages/ui`: React and Tailwind context inspector.

## Run automatically on macOS

Use `agent-context-trimmer service install` to install a per-user LaunchAgent with a stable runtime and supervised restarts. See [macOS service setup](docs/macos-service.md) for installation, updates, environment settings, and migration from an existing proxy.
