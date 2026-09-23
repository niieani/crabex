# Model route tool policy

Each model route can declare how it handles Codex tool declarations. The five
types are `function`, `namespace`, `custom`, `web_search`, and `tool_search`.
Set `tool_policy` on a route to override its defaults:

```json
{
  "authorization_env": "MODEL_GATEWAY_TOKEN",
  "upstream": "https://gateway.example/v1",
  "transport": "http",
  "tool_policy": {
    "function": "pass",
    "namespace": "pass",
    "custom": "reject",
    "web_search": "reject",
    "tool_search": "reject"
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

Entries may be omitted. A Responses route defaults to `pass` for all five
types. This forwards declarations unchanged; the upstream must support them.
An Anthropic Messages route defaults to `translate` for `function`, `namespace`,
and `custom`, and `reject` for `web_search` and `tool_search`. `reject` is
available for every type. Other `translate` actions and all `broker` actions
are reserved for later adapters and fail route validation today. Anthropic
routes cannot use `pass` because their upstream wire format differs.

Rejected declarations and rejected typed `tool_choice` values return HTTP 400
or a WebSocket error frame naming the route and tool type. The proxy does not
remove declarations from a request. Unknown declaration types also fail
visibly. Codex's model list advertises `supports_search_tool: false` when a
route rejects `tool_search`. Rejecting `custom` also disables the catalog's
`apply_patch_tool_type` and forces direct tool mode. Codex has no model-level
switch for hosted `web_search` or all namespace/function tools, so requests
containing those rejected types still receive a clear error. The user can
disable hosted web search in Codex with `web_search = "disabled"`.

The old `allowed_tool_types` list still loads. Listed types receive their
provider's default action and all other types become `reject`; the proxy logs
a deprecation warning when it loads or saves such a route. New configurations
should use `tool_policy`. Do not set both fields on one route. The local
`/__agent-context-trimmer/api/model-routes` response includes an
`effective_tool_policy` for each route alongside the editable `tool_policy`;
this derived field is not saved.
