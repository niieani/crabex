# Shared Login design

Spike evidence: a throwaway allowlisted proxy ran a key-only Codex on the subscription. Only
`/responses` (WebSocket or POST) and `/alpha/search` were used. Model catalog came from the client's
bundled list.

## Modules (`packages/proxy/src/shared-login/`)

- `policy.ts`: pure. `upstreamPath(method, pathname, webSocket)`, `refusedPayloadReason(text)`.
- `client-keys.ts`: `ClientKeyStore`. SHA-256 of secret at rest, mode 0600.
- `login.ts`: `LoginSource` seam. `createCodexHomeLogin(dir)` reads `auth.json` per request, so a
  refresh by whichever process owns the login is picked up. Refresh later plugs in here.
- `listener.ts`: `Bun.serve` for HTTP and WebSocket. Depends on the above through interfaces.
- `service.ts`: reconciles config to a running listener; holds bind errors for the UI.
- `api.ts`: local API routes under `/__crabex/api/shared-login`.

## Client routes

| Client                                          | Upstream                          |
| ----------------------------------------------- | --------------------------------- |
| `POST /v1/responses`, WebSocket `/v1/responses` | `/backend-api/codex/responses`    |
| `POST /v1/alpha/search`                         | `/backend-api/codex/alpha/search` |
| `GET /v1/models`                                | `/backend-api/codex/models`       |

Everything else: 403. Check order: key, route, body, login.

## Body policy

Allowlists throughout, after review found denylist bypasses:

- Top-level fields per route (Codex `ResponseCreateWsRequest`/`ResponsesApiRequest`,
  `SearchRequest`); tool fields per type (`ToolSpec`, `ResponsesApiTool`, `FreeformTool`).
  `/responses/compact` dropped: current Codex has no compact endpoint and compaction works without it.
- Tool types (`tools`, nested `tools`, `input[*].tools` on `tool_search_output`, `tool_choice`):
  `function`, `namespace`, `tool_search`, `web_search`, `custom` (Codex `ToolSpec`). Depth limit 8.
- `input` items whose type starts with `mcp` are refused. Message text stays opaque.
- WebSocket: `response.create` frames only (Codex `ResponsesWsRequest`); binary refused.
- Bodies: no `content-encoding`, fatal UTF-8 decode, JSON object. The checked parse is
  re-serialized and forwarded, so duplicate keys or bad bytes cannot differ upstream.
- Headers: allowlist of what Codex sends (`x-codex-*` prefix plus named ones). Query: per-route
  allowlist (`client_version` on `/models`).
- Responses: 3xx becomes 502; `location` and `set-cookie` withheld.
- Errors: clients get fixed messages; detail (owner paths) goes to the log only. `development: false`.

## Config and CLI

`shared_login: { enabled: false, listen: "127.0.0.1:8766" }` in the proxy config.
`--shared-login`, `--no-shared-login`, `--shared-login-listen`, `--shared-login-codex-home`,
`--client-keys`. Overrides lock the matching UI control, like the Apps relay.

## Local API safety

Minting a key hands out the login, so `/shared-login` answers only to a loopback peer (from Bun's
`requestIP`, passed through `LocalApi.handle`) with a loopback `Host`, a matching `Origin` when
sent, and `application/json` on writes. Holds even when the main listener is on all interfaces.

## Lifecycle notes

- WebSocket: connect upstream first, then upgrade, so refusals reach the client as HTTP statuses.
- Revocation closes the key's open sockets via `ClientKeyStore.onRevoke`; frames re-check too.
- Settings updates merge inside the service queue; only fields present are applied.
- Bun keeps counting a closed WebSocket until its closing handshake ends, and `stop(true)` waits on
  that count. `close()` waits up to 1 s for it, then bounds `stop`.
- A corrupt `client-keys.json` fails startup even with the mode off: an explicit failure over
  silently discarding issued keys.

## Login renewal

- Shares the host's Codex home rather than a dedicated login. Codex already coordinates the
  processes that share a home: it rereads `auth.json` before refreshing and saves under
  `auth.lock` with compare-and-save. The leftover race (two exchanges in the same instant) is the
  one two Codex windows already have.
- Trigger: app-server `account/read` with `refreshToken: true`, which is a forced refresh. A fresh
  app-server always exchanges, so Crabex gates it: renew only within 24 h of expiry (Codex's own
  scheduled refresh is at 8 of 10 days), after rereading the login.
- `account/read` swallows refresh failures and can fail after a successful refresh (workspace
  routing). The login on disk is the verdict, not the app-server response.
- Verified with real Codex 0.167.0 against a mock `CODEX_REFRESH_TOKEN_URL_OVERRIDE` in a
  throwaway home: one `/oauth/token` exchange with the stored refresh token, new tokens saved,
  the next check does nothing; a `refresh_token_reused` answer leaves the login unchanged and is
  reported.

## Image generation

- Not an MCP: Codex's image tool is a client-side extension that posts JSON to
  `{provider base_url}/images/generations` and `/images/edits` with the provider's credentials.
  Routing those through Shared Login keeps the native behavior (images saved and shown on the
  client, edits of local files sent inline); an MCP on the host could not read client files.
- Codex shows the tool for a custom provider with `requires_openai_auth = false` and a non-empty
  `x-openai-actor-authorization` header (`image_generation_available` in `spec_plan.rs`). The
  built-in provider with an API key never gets it. The header is not on the forward allowlist.
- Upstream: `chatgpt.com/backend-api/codex/images/{generations,edits}` answer the ChatGPT login
  (400 on a missing field, 404 on an unknown image path).
- `file_id` image references are refused: they would name files in the host's ChatGPT account.
- The client setup moved to a custom provider: `model_catalog_url` restores the model list, the
  key is read from a 0600 file by the provider's `auth.command`.
- Verified live on the Mac with Codex 0.167.0 and the owner's login: a generation and an edit of
  a local file, both 200 through Shared Login, saved under the client's `generated_images`.

## Follow-ups

- Linux service unit.
