# Model route tool policy

Each model route can declare how it handles Codex tool declarations. The five
known types are `function`, `namespace`, `custom`, `web_search`, and
`tool_search`. The `other` key covers future or unrecognized types.
Set `tool_policy` on a route to override its defaults:

```json
{
  "authorization_env": "MODEL_GATEWAY_TOKEN",
  "upstream": "https://gateway.example/v1",
  "transport": "http",
  "tool_policy": {
    "function": "pass",
    "namespace": "pass",
    "custom": "translate",
    "web_search": "reject",
    "tool_search": "translate",
    "other": "pass"
  },
  "model": {
    "slug": "example-model",
    "display_name": "Example model",
    "description": "Example Responses route",
    "template_slug": "gpt-6-astra",
    "priority": 1
  }
}
```

Entries may be omitted. A Responses route defaults to `pass` for all five known
types and `other`. This forwards declarations unchanged; the upstream must
support them.
An Anthropic Messages route defaults to `translate` for `function`, `namespace`,
and `custom`, and `reject` for `web_search`, `tool_search`, and `other`.
`reject` and `omit` are available for every key. A Responses route with HTTP
transport can set `custom: "translate"`: the proxy advertises each custom tool
upstream as a function with a required `{input: string}` parameter, then restores
Codex's custom call and result shapes on replay and response streams. Function
namespaces, union schemas, and structured tool result arrays (including images)
pass through natively. Translation on an upstream WebSocket route fails
validation. `tool_search: "translate"` is also available on HTTP Responses and
Anthropic Messages routes. Anthropic routes can set `web_search: "broker"` as
described below. Other `translate` and `broker` actions fail route validation.
Anthropic routes cannot use `pass` because their upstream wire format differs.

For Anthropic hosted web search, configure a Responses route with
`web_search: "pass"`, then set `web_search: "broker"` on the Anthropic route.
The default broker slug is `gpt-6-luna`. Set a proxy-wide default through
`search_broker.route` in the proxy config API or JSON file; an Anthropic route
can override it with its own `search_broker: {"route": "search-model"}`.
The proxy checks that the named route is enabled, uses the Responses API,
accepts native web search, and has an available authorization environment
variable. A missing or unusable route returns an error naming both routes.
The Model routes API reports each route's `search_broker_eligibility` using
these same checks, including authorization availability. The broker selectors
offer only eligible routes. A saved route that becomes ineligible stays visible
in the selector with the reason shown beside it.
The check applies when a request declares `web_search`; ordinary Anthropic
turns use the plain adapter even when the route enables brokerage.
The broker calls the configured gateway directly with low reasoning effort,
a 45-second timeout, at most three Claude search rounds, and six broker calls
per response.
Codex's access mode, filters, location, context size, and requested content
types are forwarded to the broker's native `web_search` declaration. The
broker provider determines how those hints are honored.
Broker errors become Claude tool results marked as errors so Claude can react.
The answer and URL/title list come from the broker's text and native
`url_citation` annotations. Citation offsets into that text are not applied to
Claude's separate answer. Codex sees a `web_search_call` with the query, while
an encrypted reasoning marker lets later Anthropic turns replay the exact
Claude tool call and broker result. Broker token usage and errors are visible
on the live request separately from Claude response usage.

For client tool discovery, Codex must enable namespace tools and have at least
one deferred MCP or app tool. The proxy presents Codex's `tool_search`
description and schema as a function to the upstream model. On a search call it
returns a Codex `tool_search_call` with JSON arguments; Codex executes the
search and sends `tool_search_output`. The proxy summarizes the result for the
model and adds the discovered function or namespace declarations to subsequent
requests. Anthropic receives flattened wire names; Responses routes keep native
namespaces. Codex's catalog advertises `supports_search_tool: true` when the
route translates discovery. A `pass` route keeps the template or override value.

Loaded declarations are scoped to the account, thread, and route, expire after
30 minutes, and are bounded to 256 tools and 1 MiB of declarations per scope.
A full history replay replaces the loaded set. An explicit compaction item, or
a replacement full replay with no discovery outputs, clears it; the model must
search again. A stored, delta-only continuation with no matching loaded state
fails visibly instead of calling a discovered tool without its declaration.

The proxy persists loaded declarations in `loaded-tools-cache.json` and stored
response correlation markers in `stored-responses-cache.json`, beside its
`snapshot-cache.json` (in the installed service's data directory, or beside a
custom `--snapshot-cache` path). Both caches have a 30-minute TTL and a 512-entry
LRU limit. The loaded-tools file is capped at 16 MiB and the stored-response
file at 8 MiB. Writes are debounced and atomically renamed; clean shutdown
flushes pending writes. Keys are SHA-256 digests of the scoped identity, so raw
session/account IDs and bearer tokens are not written to either file. Invalid
or version-mismatched cache files produce a warning and start empty. A later
delta-only continuation then reports lost loaded-tool state as above.

For a Fireworks Responses route verified with native web search, set
`web_search: "pass"`. The proxy forwards Codex's `web_search` declaration,
including `external_web_access` and `indexed_web_access`, unchanged. Fireworks
accepted the tested live (`true`), cached (`false`), and indexed (`true` with
`indexed_web_access: true`) forms and returned search calls and answer URLs.
Those probes do not establish whether Fireworks applies Codex's freshness or
indexing semantics. Treat these fields as requests to the provider, not as a
guarantee of live, cached, or indexed results.

Fireworks search answers in the tested streams contained ordinary URLs and no
`url_citation` annotations. The provider also added a completion-only
`tool_output` item containing URL, title, and snippet results. Codex has no
matching Responses search-source field and ignores this item; the proxy keeps
it unchanged and does not invent citation offsets. The stored-response matcher
skips provider-only output items because Codex does not replay them.

Rejected declarations and rejected typed `tool_choice` values return HTTP 400
or a WebSocket error frame naming the route and tool type. `omit` removes the
declaration and any matching typed `tool_choice` before forwarding. The proxy
logs each omitted route/type pair once and records omitted types on the live
request and capture routing metadata. Unknown string types follow `other`;
missing or non-string declaration types are invalid.

Codex's model list advertises `supports_search_tool: false` when the route
omits or rejects `tool_search`; translation forces it on, and `pass` preserves
the template or override value. Omitting or rejecting `custom` also disables the
catalog's `apply_patch_tool_type` and forces direct tool mode. Responses routes
with `custom: "translate"` advertise freeform `apply_patch` so Codex can call it.
Codex has no model-level switch for hosted `web_search` or all
namespace/function tools. The user can disable hosted web search in Codex with
`web_search = "disabled"`.

The old `allowed_tool_types` list still loads with arbitrary unique strings.
It filters only top-level declarations by exact type, keeping the children of
an allowed namespace intact. Unlisted top-level types are omitted. The proxy
logs a deprecation warning when it loads or saves such a route. New
configurations should use `tool_policy`. Do not set
both fields on one route. The local
`/__agent-context-trimmer/api/model-routes` response includes an
`effective_tool_policy` for each route alongside the editable `tool_policy`;
this derived field is not saved. It also returns `tool_policy_actions`, the
actions valid for each type under that route's API and transport. The Model
routes page uses these fields to show inherited actions, edit overrides, and
convert a legacy allowlist to an equivalent explicit policy where possible.
Exact matching for future tool types and top-level-only namespace matching
cannot be represented by the typed policy, so those allowlists remain legacy.
The page also edits the
proxy-wide search broker and native-to-routed agent opt-in, plus per-Anthropic
broker overrides and each route's advertised `multi_agent_version`.

## V2 agent handoff through routed models

Custom Responses routes using `custom: "translate"` and Anthropic routes
remove the `encrypted` annotation from outbound `collaboration` message
parameters, then mark their plaintext calls with `encrypted_function_args: []`.
Plain Responses routes keep the original declaration and any upstream
encrypted arguments unchanged. Custom-parent plaintext handoff does not depend
on the proxy-wide `routed_agents` opt-in. A routed child receives a
readable `agent_message` as a user message with sender and recipient context.
If its task contains `encrypted_content`, the route refuses it with HTTP 422
or a WebSocket 422 error event instead of forwarding unreadable ciphertext.

Native ChatGPT parents can optionally receive an additional `routed_agents`
namespace for routed custom-model children. Enable it in the proxy config
file or through `PUT /__agent-context-trimmer/api/proxy-config`:

```json
{ "version": 1, "routed_agents": { "enabled": true } }
```

This setting is off by default and logs an experimental warning when enabled
because the native backend's handling of extra tools is undocumented. The
original encrypted `collaboration` declarations remain unchanged for native
children. The extra namespace appears only when at least one enabled custom
HTTP route exists and Codex supplies the V2 collaboration declarations.
Its `spawn_agent.model` choices are the enabled routed model slugs. Use
`routed_agents.spawn_agent`, `send_message`, and `followup_task` for routed
agents, including a routed parent or sibling; use `collaboration` for native
agents. The proxy checks that a routed message target belongs to a known
routed custom-model agent in the same tree, then maps the call back to Codex's
`collaboration` name with a plaintext marker.
On later native turns it restores the `routed_agents` name in replay history.
The agent tree is linked through Codex's parent-thread metadata, including
Responses Lite `client_metadata`. A native child needs a V2-capable model
catalog entry to receive collaboration tools and spawn its own children.

The parent-thread target map persists in `routed-agents-cache.json` beside the
other session caches. It expires after 30 minutes and is limited to 512 entries
and 2 MiB. Cache keys hash thread and account identity; values contain task
names, agent paths, and model slugs, but no credentials or message text. A
missing thread/account scope leaves the extra namespace unadvertised for that
request. If the opt-in is off, encrypted messages to a custom-model child fail
visibly with an instruction to enable it. Codex does not allow
`followup_task` to target `/root`; use `send_message` for a routed root parent.

On a full-history fork, the proxy removes reasoning before the child's first
task only when the recorded parent and target have different reasoning
families. Native ChatGPT models share a family within the account-scoped tree.
Routed Responses models share a family when their upstream base URL and
provider authorization match; Anthropic replay is scoped to its route,
envelope key, and provider authorization. A model-name change within a family
does not remove reasoning. Without known lineage, the proxy keeps history as
received. The exception is proxy-sealed `acta1:` reasoning sent to a
non-Anthropic target, which it removes. Anthropic authenticates its own
envelope scope when replay opens it. A provably foreign opaque compaction is
refused with 422 because dropping it would lose the conversation summary.
Native passthrough uses the same rules. Plain assistant and user messages
remain, and same-family replay and stored continuation retain reasoning.

Full-history forks can also copy a parent's instruction to spawn agents into
its child; use a short child task or `fork_turns: "none"` when that inherited
instruction would be misleading.
