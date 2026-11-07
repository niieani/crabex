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

## Login renewal

ChatGPT access tokens last about 10 days. Codex on the host renews the login whenever you use it
and the last renewal is 8 days old. While Shared Login is on, Crabex covers idle hosts: every 5
minutes it reads `auth.json`, and in the login's last day before expiry it runs
`codex app-server` on the same Codex home and asks it to refresh the token. Codex performs the
exchange and saves the result, so Crabex never handles the refresh token.

Refresh tokens are single-use. Crabex rereads the login right before asking, so it does nothing
once another Codex process has renewed it. Two processes could still refresh at the same moment
while app-server starts, which is the same risk as two Codex windows sharing one login.

Renewal is on by default. Turn it off under **Renew the login** if something else keeps the
login fresh. A failed attempt is retried after an hour and shown in the UI.

## Set up a client

Save the Client Key on the client, readable only by you:

```sh
(umask 077 && mkdir -p ~/.config/crabex && printf %s '<client key>' > ~/.config/crabex/client-key)
```

Then add this to the client's `~/.codex/config.toml`:

```toml
model_provider = "crabex"

[model_providers.crabex]
name = "Crabex Shared Login"
base_url = "http://<host>:8766/v1"
model_catalog_url = "http://<host>:8766/v1/models"
wire_api = "responses"
requires_openai_auth = false
supports_websockets = true
http_headers = { "x-openai-actor-authorization" = "crabex-shared-login" }

[model_providers.crabex.auth]
command = "sh"
args = ["-c", "cat ~/.config/crabex/client-key"]
```

The UI shows both, filled in, when it issues a key.

The client has no ChatGPT login, so Codex offers it no Apps or connectors (`app/list` is empty).
It still gets Codex's own tools, web search and image generation:

- `model_catalog_url` makes Codex load the model list through Shared Login, as the built-in
  provider does.
- `x-openai-actor-authorization` is how Codex decides that a custom provider can generate images.
  Codex only checks that the header is set. Crabex never forwards it upstream.
- Generated images are saved on the client, under `$CODEX_HOME/generated_images/`. Edits send
  the client's local image files inline.

## What a key can reach

| Client request                                     | Upstream                                |
| -------------------------------------------------- | --------------------------------------- |
| `POST /v1/responses` and WebSocket `/v1/responses` | `/backend-api/codex/responses`          |
| `POST /v1/alpha/search` (web search)               | `/backend-api/codex/alpha/search`       |
| `GET /v1/models`                                   | `/backend-api/codex/models`             |
| `POST /v1/images/generations` (image tool)         | `/backend-api/codex/images/generations` |
| `POST /v1/images/edits` (image tool)               | `/backend-api/codex/images/edits`       |

Everything else gets 403. Crabex also checks each request body and WebSocket frame:

- Request fields, tool types and tool fields must be ones Codex sends. Tool types are `function`,
  `namespace`, `tool_search`, `web_search` and `custom`. Hosted MCP and connector tools are
  refused, as are MCP input items.
- Image requests may carry only the fields Codex's image tool sends. Edits take 1 to 5 inline
  image data URLs. File references are refused, because they name files in the host's ChatGPT
  account.
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
| `--codex-bin <path>`                  | Codex that renews the login (default `codex` on PATH)  |

Settings saved from the UI live in the proxy config as
`"shared_login": { "enabled": false, "listen": "127.0.0.1:8766", "refresh": true }`.

## Limitations

- **Unrenewable login:** if a renewal fails, typically because the refresh token is no longer
  valid, clients get a 503 once the access token expires. The UI shows the failure; sign in to
  Codex again in the shared Codex home.
- **Plain HTTP:** the listener speaks plain HTTP unless Crabex has `--tls-dir`, and that
  certificate only covers `localhost`. Away from the host, use a private network or an SSH
  tunnel.
- **Local admin only:** the Shared Login settings and key endpoints answer only to this machine.
  Requests must come from a loopback address and a loopback hostname, with no foreign `Origin`.
  To manage a remote host, tunnel the UI port with `ssh -L`.
- **One account:** all clients share the host's account and its usage limits.
