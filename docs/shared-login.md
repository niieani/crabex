# Shared Login

Shared Login lets other Codex instances use the ChatGPT login of one Crabex host. Each instance
gets a **Client Key**, which works as its API key. Those machines hold no ChatGPT credential, so
an agent running there cannot read the login, reach your ChatGPT Apps and connectors, or use the
rest of the ChatGPT backend.

Shared Login is off by default. It runs on its own listener, separate from the proxy, UI and local
API, and that listener never serves them.

## Set up the host

1. Sign in to Codex on the host. By default Crabex reads the login from the `--codex-config`
   directory (`$CODEX_HOME` or `~/.codex`). To share a dedicated login, use
   `--shared-login-codex-home <dir>` and sign in there with
   `CODEX_HOME=<dir> codex login --device-auth`.
2. Open **Setup → Shared Login**:
   1. Turn it on.
   2. Choose where it listens. **This machine only** is the default, at `127.0.0.1:8766`.
   3. Generate a key for each client.
3. The UI shows each key once, with the client setup. Only a hash is kept, in
   `.crabex/client-keys.json`.

Changes apply without a restart. Revoking a key stops it at once and closes its open WebSockets.

## Set up a client

Add this to the client's `~/.codex/config.toml`:

```toml
openai_base_url = "http://<host>:8766/v1"
```

Then sign in with the Client Key:

```sh
printf %s '<client key>' | codex login --with-api-key
```

The client uses Codex's built-in OpenAI provider with API-key authentication. Because it has no
ChatGPT login, Codex offers it no Apps or connectors (`app/list` is empty), and Codex hides its
image generation tool.

## What a key can reach

| Client request                                     | Upstream                          |
| -------------------------------------------------- | --------------------------------- |
| `POST /v1/responses` and WebSocket `/v1/responses` | `/backend-api/codex/responses`    |
| `POST /v1/alpha/search` (web search)               | `/backend-api/codex/alpha/search` |
| `GET /v1/models`                                   | `/backend-api/codex/models`       |

Everything else gets 403. Crabex also checks each request body and WebSocket frame:

- Request fields, tool types and tool fields must be ones Codex sends. Tool types are `function`,
  `namespace`, `tool_search`, `web_search` and `custom`. Hosted MCP and connector tools are
  refused, as are MCP input items.
- WebSocket frames must be `response.create`. Binary frames are refused.
- Bodies must be uncompressed, valid UTF-8 JSON. Crabex forwards its checked parse, so upstream
  never reads a different version of the body.

Only headers that Codex sends are forwarded. The key and any cookies never reach upstream, and
upstream cookies and redirects never reach the client.

Shared Login traffic is never captured, routed or transformed, so client prompts are not stored
on the host.

## Command line

| Option                                | Effect                                                 |
| ------------------------------------- | ------------------------------------------------------ |
| `--shared-login`, `--no-shared-login` | Turn it on or off for this run; locks the UI switch    |
| `--shared-login-listen <host:port>`   | Listener address; locks the UI field                   |
| `--shared-login-codex-home <dir>`     | Codex home holding the login to share                  |
| `--client-keys <file>`                | Client Key hashes (default `.crabex/client-keys.json`) |

Settings saved from the UI live in the proxy config as
`"shared_login": { "enabled": false, "listen": "127.0.0.1:8766" }`.

## Limitations

- **Token refresh:** Crabex only reads the login; it never refreshes it. ChatGPT refresh tokens
  are single-use, so two processes refreshing one login can invalidate it until you sign in again.
  Something that owns the login must keep it fresh, such as running Codex on the host now and
  then. Once the access token expires, clients get a 503 and the UI shows the expiry.
- **Plain HTTP:** the listener speaks plain HTTP unless Crabex has `--tls-dir`, and that
  certificate only covers `localhost`. Away from the host, use a private network or an SSH
  tunnel.
- **Local admin only:** the Shared Login settings and key endpoints answer only to this machine.
  Requests must come from a loopback address and a loopback hostname, with no foreign `Origin`.
  To manage a remote host, tunnel the UI port with `ssh -L`.
- **One account:** all clients share the host's account and its usage limits.
