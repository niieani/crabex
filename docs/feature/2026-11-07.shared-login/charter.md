# Shared Login

## Brief

Add a new, optional mode that lets other Codex instances use one ChatGPT login held by a Crabex
instance, so those machines hold no real ChatGPT credential and cannot reach the owner's Apps or
connectors. Existing passthrough behavior does not change. The mode is off by default and fully
configurable from the UI, including issuing API keys and choosing non-localhost listening.

## Goal

With Shared Login on, a Codex configured with only a Client Key and
`openai_base_url = "http://<host>:<port>/v1"` runs models, tools, compaction, subagents, and web
search on the subscription, while every other backend route is refused.

## Settled decisions

- Name: **Shared Login**; credentials are **Client Keys**. "Gateway" already means upstream routes.
- Separate listener; the UI and local API never appear on it. No captures, routes, or
  Transformations apply to its traffic, so client prompts are not stored or parsed by the catalog.
- Path allowlist, not a denylist. Hosted `mcp`/connector tools in request bodies are refused.
- Crabex reads the login's `auth.json` and never handles the refresh token. Renewal is delegated
  to `codex app-server` on the same Codex home, only in the login's last day, after rereading it
  (refresh tokens are single-use). On by default while Shared Login is on; can be turned off.
- Off by default, loopback listener by default.
- Claude credentials are out of scope: Anthropic terms forbid intermediating them.

## Scope

In: Client Key store, listener (HTTP and WebSocket), allowlist, body policy, read-only login source,
config and CLI switches, local API, UI card, docs.

Added later in this work: login renewal through `codex app-server`.

Out, tracked as follow-ups: image generation exposed
as an MCP tool; Linux service unit; deployment.

## Criteria

| Criterion                                                                                                             | Verifier                             |
| --------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| Off by default; no listener without opt-in; existing behavior unchanged                                               | Config/service tests; existing suite |
| Wrong or revoked key gets 401; off-list path gets 403; neither reaches upstream                                       | Listener tests with fake upstream    |
| Client credentials and cookies never reach upstream; login token is injected; upstream cookies never reach client     | Listener tests                       |
| Hosted `mcp`/connector tools and unreadable bodies refused over HTTP and WebSocket                                    | Policy and listener tests            |
| Key secrets are stored hashed, shown once, never returned by list                                                     | Store and API tests                  |
| Missing, non-ChatGPT, or expired login gives an explicit 503; token values never leave the process except to upstream | Login and listener tests             |
| UI toggles the mode, changes the listen address, issues and revokes keys; applies without restart                     | UI and API tests                     |
| Key-only Codex completes a tool-using turn, resume, compaction, and web search; `app/list` is empty                   | Live run                             |

`vp check` and `vp run test` pass. Reviewed by a subagent against this charter.

## Execution shape

Sliced: core policy and stores; listener and service; API and UI; docs and live run.
No push or release without the owner's approval.
