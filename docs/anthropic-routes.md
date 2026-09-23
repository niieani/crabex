# Anthropic Messages routes

Relaydeck translates Codex's Responses protocol into native Anthropic Messages.
This works with Anthropic-compatible gateways, including Bedrock Mantle, using
HTTP/SSE upstreams and either HTTP/SSE or WebSocket Codex clients. No Converse,
AWS binary EventStream, or Chat Completions intermediary is needed.

## Configure a route

Choose **Anthropic Messages (including Bedrock Mantle)** in Model routes, or add
an entry to the local route file. Keep actual infrastructure configuration in
`.agent-context-trimmer/`; the following uses a reserved example domain.

```json
{
  "version": 1,
  "routes": [
    {
      "api": "anthropic-messages",
      "transport": "http",
      "authorization_env": "ANTHROPIC_GATEWAY_TOKEN",
      "upstream": "https://gateway.example/anthropic",
      "upstream_model": "anthropic.claude-sonnet-5",
      "anthropic": {
        "auth": "bearer",
        "thinking": "adaptive",
        "max_tokens": 32768,
        "cache_prompt": true
      },
      "model": {
        "slug": "claude-sonnet",
        "display_name": "Claude Sonnet",
        "description": "Claude via Anthropic Messages",
        "template_slug": "gpt-6-astra",
        "priority": 1,
        "overrides": { "context_window": 200000 }
      }
    }
  ]
}
```

The upstream base may end in `/anthropic`, `/anthropic/v1`, or
`/anthropic/v1/messages`; the final request goes to `/anthropic/v1/messages`.
Model IDs are explicit: use the ID accepted by the gateway, without adding a
Bedrock inference-profile prefix automatically. First-party Anthropic uses its
own model IDs and `auth: "api-key"`, which sends `x-api-key`. Gateway routes
usually use `bearer`. The proxy sends `anthropic-version: 2023-06-01`; optional
`anthropic.beta` is an array of upstream beta names. Codex cookies, OAuth tokens,
account IDs and OpenAI-specific headers are not forwarded to these upstreams.

The default output limit is 32768 tokens, including thinking. A caller's smaller
`max_output_tokens` is honored; larger values are capped at the route limit.
Choose limits supported by your model/provider. The advertised context window
defaults conservatively to 200000 and can be overridden. This is a routing default,
not a claim about the model's maximum capacity.

## Thinking, tools, and images

Adaptive thinking maps Codex `low`, `medium`, `high`, `xhigh`, and `max` directly
to Anthropic effort. `minimal` maps to `low`; `none` explicitly disables thinking.
Use models supporting the selected levels. Older models can select
`thinking: "budget"` with optional `budget_tokens` (at least 1024); the budget is
kept below the total output limit. `thinking: "disabled"` disables it route-wide.
Forced tool choice requires thinking off. New Claude models use adaptive mode.

Function calls, parallel calls, namespaces, and custom/freeform tools are
translated in both directions. Custom tools, including `apply_patch` and
code-mode `exec`, use a JSON object containing a string `input` upstream and
return as native Codex custom calls. Grammar-constrained generation is not
available through this wrapping. Claude routes default to regular Codex tools;
`model.overrides.tool_mode: "code_mode_only"` explicitly opts into code mode.
No tool executes in Relaydeck: Codex remains responsible for execution and
approvals. Broken call/result pairs and unsupported hosted tools fail explicitly.
See [model route tool policy](model-route-tool-policy.md) for per-route rejection
and the defaults for all five Codex tool types.

Base64 PNG/JPEG/GIF/WebP images work in user messages and tool results, including
`view_image`. HTTPS image URLs are passed as native URL sources rather than
fetched by the proxy; provider support varies (use base64 on Mantle). OpenAI
file IDs are not portable and fail with an actionable error.

## Resume and compaction

Responses use an empty response ID, telling Codex to replay full history instead
of sending `previous_response_id`. Warmup `generate:false` requests are answered
locally without billing a generation. HTTP clients must likewise send full input;
unresolved `previous_response_id` requests are rejected, not silently reset.

Signed thinking text, signatures, and redacted thinking blocks are stored in an
AES-256-GCM authenticated envelope in reasoning `encrypted_content`. The original
blocks are restored from this envelope, even if a displayed reasoning summary was
trimmed. Envelopes are bound to the advertised route slug and upstream URL;
thinking blocks additionally identify their upstream model.

The CLI creates `<model-routes-file>.anthropic-key` with mode 0600 once and reuses
it on subsequent launches. **Back up this key with the route file and Codex
sessions.** Losing it prevents decryption of saved thinking and compaction.
Token rotation does not change it. Embedded `startReverseProxy` callers must pass
a stable 32-byte `anthropicKey` for resume across instances; an omitted key is
intentionally ephemeral. Do not copy opaque history between providers/routes.

Both current `compaction_trigger` requests and legacy `POST /responses/compact`
are supported. Relaydeck asks Claude for a continuation summary preserving goals,
instructions, changes, decisions and pending work, then emits a Codex compaction
item containing the encrypted summary. Later requests decode it into context.
This state is self-contained in the saved task and survives proxy restarts; no
in-memory conversation registry is needed. Current Codex retains its own recent
history/image budget around the compaction item; the legacy endpoint retains the
latest image-bearing user turn in its replacement history. Compaction is a model
summary and can lose detail, just as other summarization workflows can.

## Streaming and limitations

The adapter emits complete Responses lifecycle events, checks fragmented tool
JSON, retains signed thinking, maps cumulative usage (including cache reads and
writes), and propagates cancellation. A missing terminal event, invalid tool,
output limit, or upstream failure never becomes a successful response. Retries
are limited to before output is committed; partial output is never transparently
replayed against a different target. Existing route retries and circuit breakers
apply; upstream overload HTTP 529 can be added to `retry.on_status` if needed.

Hosted OpenAI tools and OpenAI-encrypted reasoning/compaction cannot be translated.
Disable hosted web search for these tasks (`web_search = "disabled"`). Claude
routes disable deferred tool search and Responses-lite, and advertise no OpenAI
speed/access programs. Hosted web search still needs the task setting above.
Structured response schemas are currently rejected because the targeted Mantle
surface does not support them. Client-executed MCP/function tools remain
available. This adapter does not implement direct AWS SigV4 authentication.

## Verification and sources

Run `vp check`, `vp run test`, and `vp run build`. Adapter tests cover request
validation, custom/namespaced tools, signed replay, images, compaction and fresh
proxy instances, HTTP/WS, warmups, terminal failures, cache accounting and stream
cancellation. Use the repository's isolated live OAuth workflow with Sonnet when
changing the wire contract; test actual Codex tool execution and resume after
compaction, not only a single text completion.

- [Anthropic on Bedrock Mantle](https://platform.claude.com/docs/en/build-with-claude/claude-in-amazon-bedrock)
- [Anthropic streaming](https://platform.claude.com/docs/en/build-with-claude/streaming)
- [Effort](https://platform.claude.com/docs/en/build-with-claude/effort)
- [LiteLLM Mantle routing](https://docs.litellm.ai/docs/providers/bedrock_mantle)
- [opencodex attribution](../THIRD_PARTY_NOTICES.md)

For models with always-on adaptive thinking (including Opus 5.5), set
`anthropic.thinking_required: true`. This removes the “none” effort from
advertised defaults and keeps thinking enabled during compaction.
Set `anthropic.drop_mismatched_thinking: true` to enable Anthropic's
thinking-binding controls beta and discard only thinking blocks whose conversation
prefix has changed (for example after Codex changes its tool inventory). Unchanged
signed thinking continues to replay. Forced tool use remains unsupported on these models.

Desktop tools with a top-level JSON Schema `oneOf`, `anyOf`, or `allOf`
are wrapped in a required `arguments` object for Anthropic. Local references
are relocated with the schema. The adapter unwraps generated arguments before
sending them to Codex and restores the wrapper when replaying tool history.
This preserves the original schema constraints and the client's tool interface.
