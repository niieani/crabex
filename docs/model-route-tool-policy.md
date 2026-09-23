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
    "tool_search": "reject",
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
validation. Other `translate` actions and all `broker` actions are reserved for
later adapters and fail route validation today.
Anthropic routes cannot use `pass` because their upstream wire format differs.

Rejected declarations and rejected typed `tool_choice` values return HTTP 400
or a WebSocket error frame naming the route and tool type. `omit` removes the
declaration and any matching typed `tool_choice` before forwarding. The proxy
logs each omitted route/type pair once and records omitted types on the live
request and capture routing metadata. Unknown string types follow `other`;
missing or non-string declaration types are invalid.

Codex's model list advertises `supports_search_tool: false` when a route omits
or rejects `tool_search`. Omitting or rejecting `custom` also disables the
catalog's `apply_patch_tool_type` and forces direct tool mode. Responses routes
with `custom: "translate"` advertise freeform `apply_patch` so Codex can call it.
Codex has no model-level switch for hosted `web_search` or all
namespace/function tools. The user can disable hosted web search in Codex with
`web_search = "disabled"`.

The old `allowed_tool_types` list still loads. Listed supported types receive
their provider's default action; all unlisted and unknown types become `omit`,
preserving the previous outbound tool list. Listing a type the provider cannot
handle fails validation. The proxy logs a deprecation warning when it loads or
saves such a route. New configurations should use `tool_policy`. Do not set
both fields on one route. The local
`/__agent-context-trimmer/api/model-routes` response includes an
`effective_tool_policy` for each route alongside the editable `tool_policy`;
this derived field is not saved.
