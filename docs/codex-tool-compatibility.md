# Codex tools and agent handoff on model routes

Configure a route in the Model routes page or `model-routes.json`. The page shows each route's effective tool policy, valid actions, handoff class, broker choice, and agent settings. The proxy config API holds the default search broker and the native `routed_agents` opt-in.

## Tool policy

`tool_policy` has six keys: `function`, `namespace`, `custom`, `web_search`, `tool_search`, and `other` (future declaration types). Omitted keys inherit the route's API defaults.

| Action      | Effect                                                                                                                                                                                        |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pass`      | Forward the declaration unchanged. The upstream must support it.                                                                                                                              |
| `translate` | Adapt the declaration, calls, results, streams, and replay. Available for `custom` and `tool_search` on HTTP Responses routes, and for Anthropic function/namespace/custom and `tool_search`. |
| `broker`    | Execute Anthropic `web_search` through a configured Responses route.                                                                                                                          |
| `omit`      | Remove the declaration and matching typed `tool_choice`; log and record the omission on the request.                                                                                          |
| `reject`    | Fail the request with an error naming the route and tool type.                                                                                                                                |

Responses routes default to `pass` for every key. Anthropic routes default to translation for function, namespace, and custom; they reject hosted search, client tool discovery, and unknown types unless configured. Invalid action/API/transport combinations fail route validation. A Responses route needs HTTP upstream transport for translated `custom` or `tool_search`. Anthropic routes cannot use `pass` for tool declarations because their wire format differs.

```json
{
  "transport": "http",
  "tool_policy": {
    "function": "pass",
    "namespace": "pass",
    "custom": "translate",
    "web_search": "pass",
    "tool_search": "translate",
    "other": "pass"
  }
}
```

This is a route fragment; the route also needs its model, upstream, and authorization fields. The proxy advertises `supports_search_tool: true` when `tool_search` translates, forces it off for omit/reject, and preserves the template value for pass. It enables freeform `apply_patch` for translated custom tools. Codex has no catalog switch for every hosted or namespaced tool; use its `web_search = "disabled"` setting when necessary.

Existing `allowed_tool_types` lists still work: they match top-level declaration types exactly, keep children of an allowed namespace, omit unlisted types visibly, and log a deprecation warning. They accept arbitrary unique strings. Do not set both an allowlist and `tool_policy`. The UI offers conversion when an exact typed-policy equivalent exists.

## Translation and search

On HTTP Responses routes, `custom: "translate"` wraps a custom declaration as a function taking `{input: string}` and maps its call, input stream, output, and replay back to Codex's custom-tool shape. Namespaces and union schemas pass through to Responses upstreams. Structured function outputs, including image parts, are forwarded; the upstream decides whether it accepts them. Anthropic uses the shared codec to flatten namespaced tools, wrap custom tools and unions, and restore Codex calls. A translated client `tool_search` becomes a provider function. When Codex returns `tool_search_output`, the proxy summarizes the result and injects the discovered declarations into later requests. The codec keeps their wire-name map, including namespace restoration.

A Fireworks route verified for native search can set `web_search: "pass"`. The proxy forwards `external_web_access` and `indexed_web_access` as supplied. The provider accepted the tested live, cached, and indexed forms; that does not prove it applies Codex's freshness or indexing semantics. The observed answer contained URLs but no `url_citation` annotations. Fireworks also returned a completion-only `tool_output` source item that Codex ignores. The proxy does not invent citation offsets.

For Anthropic search, set `web_search: "broker"` and choose an enabled, authorized Responses route with effective `web_search: "pass"`. The proxy-wide `search_broker.route` defaults to `gpt-6-luna`; an Anthropic route may override it. The API and UI show whether a chosen route is eligible. A missing or unusable broker fails visibly when search is requested. The proxy calls the broker directly with low reasoning effort, a 45-second timeout, at most three search rounds and six calls per response. Search calls appear in Codex's stream while Claude continues writing. Broker usage and status are recorded separately from Claude response usage. Broker errors returned to Claude and shown in live activity contain a proxy code and HTTP status, without upstream error bodies. Broker URLs/titles can accompany the search event; offsets into Claude's answer are never fabricated.

## V2 agent handoff

A route's `handoff_class` is `plaintext` or `native-encrypted`. Anthropic and Responses routes with stored continuation or translated custom tools default to `plaintext`. Other Responses routes default to `native-encrypted`. Anthropic supports only `plaintext`, and a plaintext Responses route needs HTTP upstream transport. In isolated trials, the configured OpenAI Responses gateway read encrypted tasks from both a native ChatGPT parent and a parent on that same gateway. That supports the default for those routes; another backend or account may have a different encryption domain. Override the class when a route's actual behavior differs.

A plaintext-class route removes Codex's encrypted annotation from outbound collaboration message parameters, marks its calls `encrypted_function_args: []`, and presents readable `agent_message` items as user messages preserving sender and recipient. It refuses an unreadable encrypted task with 422 on HTTP or the bridged WebSocket path. A native-encrypted route forwards the original declaration and encrypted agent messages. The native ChatGPT passthrough keeps its reserved encrypted collaboration tools.

| Route pattern                                                           | Starting settings                                                                                                              |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| OpenAI Responses gateway proven to read native collaboration ciphertext | `handoff_class: "native-encrypted"`; keep native tool declarations on `pass`.                                                  |
| Fireworks Responses route using stored continuation                     | `handoff_class: "plaintext"`, `custom: "translate"`, `tool_search: "translate"`; set `web_search: "pass"` only where verified. |
| Anthropic Messages route                                                | `handoff_class: "plaintext"`, `tool_search: "translate"`, and `web_search: "broker"` with an eligible Responses broker.        |

To let a native parent reach plaintext-class routes, enable proxy-wide `routed_agents` (off by default):

```json
{
  "version": 1,
  "routed_agents": {
    "enabled": true,
    "instructions": "Use the fast route for short checks."
  }
}
```

The proxy adds a non-reserved `routed_agents` namespace only when an enabled plaintext-class HTTP route exists and Codex declares V2 collaboration tools. Its `spawn_agent.model` enum lists those route slugs. The original `collaboration` namespace remains untouched for native-to-native encrypted calls. Each extra tool says it has the same parameters and delegation rules as its `collaboration` counterpart and lists the eligible models. The proxy also appends a deterministic developer instruction to native requests. `routed_agents.instructions` (up to 1,200 characters) appears in the namespace description and that instruction. A route's `agent_guidance` (up to 240 characters) appears beside its slug. The opt-in logs a warning because the native backend's extra-tool behavior is undocumented.

The proxy restores a `routed_agents` call to Codex's `collaboration` name with an empty encrypted-args marker, then restores the variant name in replay. It tracks child paths and models in the agent tree, including after a proxy restart, so native agents can message plaintext-class parents and siblings. Relative targets resolve against the caller's canonical path; unknown paths fail visibly. `followup_task` cannot target `/root` in Codex; use `send_message` for a root parent. To let a child delegate again, enable Codex's V2 feature and advertise `multi_agent_version: "v2"` for that model. The global feature flag and the active thread's chosen version take precedence over a later catalog edit.

If a native agent uses reserved `collaboration.spawn_agent` for a plaintext-class route, its encrypted task fails at the child with an instruction to use `routed_agents.spawn_agent` for that slug. The same refusal points to `routed_agents.send_message` or `followup_task` for encrypted messages. With the opt-in off, the error explains how to enable it. The refusal appears as an errored child or tool output to the parent; the proxy never forwards unreadable ciphertext. Codex's native collaboration tool advertises only its picker-visible model overrides, which may omit an otherwise accepted route. Explicit model selection or the `routed_agents` enum avoids that discovery limit.

A full-history fork can inherit another provider's reasoning or instructions. The proxy removes reasoning before the child's task only when the recorded parent and child have different reasoning families. Native ChatGPT models share a family within the account; routed Responses models share one only for the same upstream origin and authorization; Anthropic envelopes carry their own authenticated route scope. Same-family replay and stored continuation retain reasoning. A proxy-sealed Anthropic `acta1:` envelope sent to a non-Anthropic route is removed. Unknown provenance is kept. A provably foreign opaque compaction fails with 422 because removing it would lose the summary. For inherited instructions that mislead the child, use a short task or `fork_turns: "none"`.

## Persistent state and failure recovery

The proxy stores `loaded-tools-cache.json`, `stored-responses-cache.json`, and `routed-agents-cache.json` beside `snapshot-cache.json` (or beside the configured snapshot cache path). Keys hash account/thread/session scope; no bearer tokens or raw account IDs are persisted. Files have a 30-minute TTL, a 512-entry LRU limit, and size caps of 16 MiB, 8 MiB, and 2 MiB respectively. Writes are debounced and atomically renamed. Corrupt or version-mismatched files produce a warning and start empty.

Loaded discovery state is also bounded to 256 tools and 1 MiB of declarations per scope. Full replay replaces it. Detected compaction clears it, so the model must search again. A stored delta-only continuation after that state is lost fails visibly. The request inspector shows omitted tools, broker usage, ciphertext refusals, and foreign-history errors. It does not turn provider URLs into fabricated citations or guarantee source freshness.
