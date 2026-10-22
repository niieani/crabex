# Apps authentication relay

When `chatgpt_base_url` points at Crabex, Codex also sends Apps MCP traffic
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

Use **Connection → Proxy settings → Apps authentication relay** to toggle it.
Changes take effect immediately, clear cached credentials when disabling, and
persist in `.crabex/config.json`:

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
