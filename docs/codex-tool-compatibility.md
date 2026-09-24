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

The proxy adds a non-reserved `routed_agents` namespace to native ChatGPT requests and native-encrypted-class Responses routes, over HTTP or bridged WebSocket, only when an enabled plaintext-class HTTP route exists and Codex declares V2 collaboration tools. Its `spawn_agent.model` enum lists those route slugs. The original `collaboration` namespace remains untouched for encrypted native-to-native or gateway-to-gateway calls. Each extra tool says it has the same parameters and delegation rules as its `collaboration` counterpart and lists the eligible models. The proxy also appends a deterministic developer instruction to these requests. `routed_agents.instructions` (up to 1,200 characters) appears in the namespace description and that instruction. A route's `agent_guidance` (up to 240 characters) appears beside its slug. The opt-in logs a warning because the backend's extra-tool behavior is undocumented.

The proxy restores a `routed_agents` call to Codex's `collaboration` name with an empty encrypted-args marker, then restores the variant name in replay. It tracks child paths and models in the agent tree, including after a proxy restart, so native agents can message plaintext-class parents and siblings. Relative targets resolve against the caller's canonical path; unknown paths fail visibly. `followup_task` cannot target `/root` in Codex; use `send_message` for a root parent. To let a child delegate again, enable Codex's V2 feature and advertise `multi_agent_version: "v2"` for that model. The global feature flag and the active thread's chosen version take precedence over a later catalog edit.

If a native agent uses reserved `collaboration.spawn_agent` for a plaintext-class route, its encrypted task fails at the child with an instruction to use `routed_agents.spawn_agent` for that slug. The same refusal points to `routed_agents.send_message` or `followup_task` for encrypted messages. With the opt-in off, the error explains how to enable it. The refusal appears as an errored child or tool output to the parent; the proxy never forwards unreadable ciphertext. Codex's native collaboration tool advertises only its picker-visible model overrides, which may omit an otherwise accepted route. Explicit model selection or the `routed_agents` enum avoids that discovery limit.

A full-history fork can inherit another provider's reasoning or instructions. The proxy removes reasoning before the child's task only when the recorded parent and child have different reasoning families. Native ChatGPT models share a family within the account; routed Responses models share one only for the same upstream origin and authorization; Anthropic envelopes carry their own authenticated route scope. Same-family replay and stored continuation retain reasoning. A proxy-sealed Anthropic `acta1:` envelope sent to a non-Anthropic route is removed. Unknown provenance is kept. A provably foreign opaque compaction fails with 422 because removing it would lose the summary. For inherited instructions that mislead the child, use a short task or `fork_turns: "none"`.

## Verified combinations

This is a record of small live trials on 2026-09-23 PDT (some captures are dated September 24 UTC), not a provider capability guarantee. The V2 and final regression runs used Codex CLI `0.156.1`, low reasoning effort, and isolated Codex homes; the earliest direct provider probes did not record a CLI version. `WS` means Codex WebSocket to the proxy, including bridged routes; `HTTP` means Codex HTTP, including forced fallback. A dash means that combination was not exercised. The search trials used cached search where Codex offered that setting.

| Route type and model                             | Function / namespace                | Custom tool              | Hosted web search                                   | Deferred `tool_search`             | Codex transport exercised                     |
| ------------------------------------------------ | ----------------------------------- | ------------------------ | --------------------------------------------------- | ---------------------------------- | --------------------------------------------- |
| Fireworks Responses: `glm-5.3-flash`             | Namespaced MCP call                 | Translated `apply_patch` | Native search event and answer URL                  | Search, discovery, namespaced call | WS + HTTP for all four                        |
| Fireworks Responses: `kimi-k3`, `glm-5.3`        | Namespaced MCP call                 | Translated `apply_patch` | Native search event and answer URL                  | Search, discovery, namespaced call | HTTP; WS not separately tested                |
| Anthropic Messages: `anthropic.claude-haiku-4-5` | Namespaced MCP call through adapter | Translated `apply_patch` | Brokered search, streamed event and source URL      | Search, discovery, namespaced call | WS + HTTP for all four                        |
| Anthropic Messages: `claude-opus-5.5`            | One shell call                      | —                        | One brokered search and source URL                  | —                                  | Installed-proxy smoke; transport not recorded |
| OpenAI Responses gateway: `gpt-6-luna`           | Namespaced MCP call                 | —                        | Native search with `url_citation` in a direct probe | —                                  | MCP on WS + HTTP; web probe over HTTP         |
| ChatGPT passthrough: `gpt-5.6-luna`              | Encrypted `collaboration` namespace | —                        | —                                                   | —                                  | V2 on WS + HTTP                               |

In direct discovery probes, GLM Flash and Haiku called the offered search function first in 3/3 prompts each, then called the newly declared tool correctly in 3/3 follow-ups each. The Fireworks `kimi-k3` and `glm-5.3` trials also preserved `previous_response_id` chains across tool calls and a resumed turn with reasoning items. `glm-5.3-flash` preserved stored continuation and discovered tools across a proxy restart and WS-to-HTTP switch. A `gpt-6-luna` gateway MCP replay retained its own encrypted reasoning on WS and matched the pre-adapter `main` behavior on both transports; low-effort HTTP runs emitted no encrypted reasoning item. Fireworks search returned URLs but no `url_citation` offsets. The Opus row is only one shell-plus-search smoke, not an adapter-wide verification for that model.

| V2 handoff or fork                                                                                                              | Observed result                                                                                                                                                                                                                                                        | Codex transport exercised                                           |
| ------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `glm-5.3-flash`, `kimi-k3`, `glm-5.3` → same-model child                                                                        | Readable spawn, `send_message`, and `followup_task` completed.                                                                                                                                                                                                         | Flash: WS + HTTP; Kimi and GLM 5.3: HTTP                            |
| `anthropic.claude-haiku-4-5` → Haiku child                                                                                      | Readable spawn and follow-up completed.                                                                                                                                                                                                                                | Spawn: WS + HTTP; follow-up: HTTP                                   |
| ChatGPT `gpt-5.6-luna` → native `gpt-5.6-luna`; gateway `gpt-6-luna` → gateway `gpt-6-luna`                                     | Reserved `collaboration` kept encrypted tasks; both children answered. Native pair worked with `routed_agents` off and on.                                                                                                                                             | Native pair: WS + HTTP; gateway pair: WS                            |
| ChatGPT `gpt-5.6-luna` → gateway `gpt-6-luna`; gateway `gpt-6-luna` → ChatGPT `gpt-5.6-luna`                                    | Reserved encrypted spawn worked in both directions. The gateway child sent an encrypted message to its native parent; the native child sent one to its gateway parent and handled a follow-up.                                                                         | Bridged WS for gateway requests                                     |
| ChatGPT `gpt-5.6-luna` or gateway `gpt-6-luna` → Fireworks `glm-5.3-flash`                                                      | `routed_agents` delivered a readable task; send/follow-up worked, including after proxy restart for the ChatGPT parent.                                                                                                                                                | ChatGPT parent: HTTP; gateway parent: WS + HTTP spawn, WS follow-up |
| Fireworks `glm-5.3-flash` → gateway `gpt-6-luna`                                                                                | Gateway child sent a readable `routed_agents.send_message` to its plaintext-class parent.                                                                                                                                                                              | Bridged WS                                                          |
| Fireworks `glm-5.3-flash` or Anthropic `anthropic.claude-haiku-4-5` → ChatGPT `gpt-5.6-luna` → native `gpt-5.6-luna` grandchild | Native child accepted a readable task, spawned its grandchild with encrypted collaboration, and sent a readable message to the plaintext-class root. Haiku also sent a follow-up to the native child; a native child sent a readable follow-up to a Fireworks sibling. | GLM tree: WS + HTTP; Haiku tree and sibling message: HTTP           |
| Full-history forks: GLM → native, Haiku → native, native → Haiku, GLM → Haiku                                                   | Tiny tasks completed. Sampled child requests contained no inherited reasoning; synthetic tests cover foreign reasoning removal.                                                                                                                                        | HTTP                                                                |

The full-history native → GLM fork caused the child to repeat an inherited spawn instruction and create extra descendants; Haiku → GLM was inconclusive after the same issue and a thread limit. Neither is a clean task-completion pass. An exploratory `gpt-5.5` parent accepted a temporary rewrite of reserved tool declarations and handed a readable task to GLM, but that rewrite was **not** shipped: `gpt-5.6-luna` rejected it. The shipped additive `routed_agents` variant was exercised with `gpt-5.6-luna` and, in one spawn trial, `gpt-6-sol`.

Not verified: long-context compaction in a live session; provider search freshness or indexed-search semantics; Fireworks/Claude citation offsets in answer text; Opus tools beyond one shell-plus-broker smoke; Codex App rendering; every provider/account encryption domain; all JSON Schema variants; reliable full-history forks with inherited parent instructions; WS for Kimi and GLM 5.3, or HTTP fallback for Opus and the new gateway ↔ ChatGPT encrypted handoffs. Unit tests cover several state and boundary cases but do not turn them into live-provider evidence.

For V2 smoke tests, use a persistent isolated `CODEX_HOME` and omit `codex exec --ephemeral`. An ephemeral run cannot register a child thread and failed `spawn_agent` with `no thread with id`. Plain, single-agent OAuth probes may still use `--ephemeral`.

## Persistent state and failure recovery

The proxy stores `loaded-tools-cache.json`, `stored-responses-cache.json`, and `routed-agents-cache.json` beside `snapshot-cache.json` (or beside the configured snapshot cache path). Keys hash account/thread/session scope; no bearer tokens or raw account IDs are persisted. Files have a 30-minute TTL, a 512-entry LRU limit, and size caps of 16 MiB, 8 MiB, and 2 MiB respectively. Writes are debounced and atomically renamed. Corrupt or version-mismatched files produce a warning and start empty.

Loaded discovery state is also bounded to 256 tools and 1 MiB of declarations per scope. Full replay replaces it. Detected compaction clears it, so the model must search again. A stored delta-only continuation after that state is lost fails visibly. The request inspector shows omitted tools, broker usage, ciphertext refusals, and foreign-history errors. It does not turn provider URLs into fabricated citations or guarantee source freshness.
