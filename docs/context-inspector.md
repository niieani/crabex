# Context inspector design

## Purpose

Agent Context Trimmer answers one primary question: what consumes the tokens supplied to a model before useful work begins, and which of those inputs can be safely removed or mechanically rewritten?

The primary workflow is one deliberately trivial Probe, such as asking the model to reply with a fixed string. The product is request-centric rather than a general session-history analyzer. Protocol events and timing remain useful diagnostics, but are not the main interface.

## Verified protocol findings

The live `gpt-5.6-luna` Codex TUI Probe captured on 2026-08-14 contains two linked client `response.create` WebSocket messages:

1. A `generate:false` prewarm request containing an `additional_tools` item and the base developer message.
2. The actual inference request, linked through `previous_response_id`, containing dynamic developer context, injected project context, and the smoke prompt.

The effective initial context must therefore be reconstructed as a request chain. Treating either payload alone as the complete input would omit material inference context.

Observed data from that Probe:

| Context                     | Characters |
| --------------------------- | ---------: |
| Base developer instructions |     17,730 |
| Serialized tool namespace   |     28,544 |
| `exec` tool description     |     24,607 |
| Skills instructions         |     21,448 |
| Permissions instructions    |        362 |
| Apps instructions           |        646 |
| Plugin instructions         |      1,014 |
| Recommended plugins         |      1,798 |
| AGENTS.md instructions      |      7,206 |
| Environment context         |        428 |
| Smoke prompt                |         28 |

The prewarm response reported 9,872 input tokens. The final response reported 17,938 input tokens, including 8,960 cached tokens, and 6 output tokens. Server usage is authoritative only at the request level; per-part token counts must be labeled estimates.

The capture contains structured roles, item types, content blocks, tool envelopes, model, response IDs, request kind metadata, and aggregate usage. It does not contain exact per-part token usage.

Tools are only manipulated at boundaries represented structurally in the payload. In the observed request, `exec`, `wait`, and `request_user_input` are structured outer tools. Individual tools documented inside the opaque `exec` description are not parsed or independently toggled.

## Harness identity

The proxy can classify the harness before discarding request headers:

```text
Originator: Codex Desktop
User-Agent: Codex Desktop/0.148.0-alpha.9 (...) (Codex Desktop; 26.810.41047)

Originator: codex-tui
User-Agent: codex-tui/0.146.0 (...) (codex-tui; 0.146.0)
```

`Originator` is the primary discriminator. `User-Agent` corroborates the kind and supplies version/build metadata. A disagreement is recorded as a conflict rather than guessed. Captures continue to exclude request headers, authorization, account IDs, and cookies; only normalized, allowlisted harness metadata is retained.

Model comes directly from `response.create`. Project identity must be supplied explicitly to the proxy or Probe instead of being extracted from opaque environment prose.

## Core model

```text
Probe
├── Observation Conditions
│   ├── Harness kind and version
│   ├── Model
│   └── Project key, when supplied
└── Snapshot
    ├── Linked Requests
    │   ├── Prewarm
    │   └── Inference request
    └── Context Parts
        └── Variants

Transformation Set
├── Global defaults
├── Harness/model overrides
└── Project overrides
```

A Context Part is an opaque leaf located through the Responses structure, for example:

```text
message / developer / input_text
message / user / input_text
additional_tools / namespace / exec / description
additional_tools / namespace / wait / parameters
```

Each observed Variant retains its exact content, digest, character count, estimated tokens, structural locator, and Observation Conditions. User labels may name parts such as “Codex base instructions,” but labels never participate in runtime matching.

The Context Catalog is the union of observed data, not a claim that every possible context has been discovered.

## Transformations

Supported operations:

- Delete a whole structurally selected part.
- Replace the first literal occurrence.
- Replace all literal occurrences.
- Replace a regular expression.

Structural selection and text mutation are separate concerns. Rules choose eligible opaque fields—message text, tool descriptions, schema string fields, a structural slot, or a known Variant—then apply a mechanical operation.

Applicable rules execute in deterministic layers:

```text
Original payload
  → global defaults
  → harness/model overrides
  → project overrides
  → effective payload
```

Every rule declares match cardinality. Zero matches may be an intentional “if present” no-op. Invalid expressions, unexpected counts, ambiguity, or required drift are explicit errors. Rule output includes a before/after digest, match count, applied rule IDs, and estimated size delta. Captures remain immutable; transformed payloads are recorded alongside originals.

Runtime statuses:

```text
MATCHED     Eligible known input found; transformation applied
ABSENT      No eligible match; allowed no-op
DRIFTED     Strict structural target contains an unknown Variant
AMBIGUOUS   Structural selection resolves to multiple unintended targets
FAILED      Invalid operation or unexpected cardinality
```

Regular expressions require bounded execution semantics. The implementation should use RE2-compatible expressions rather than permit catastrophic backtracking.

## Primary UI

```text
┌──────────────────────────────────────────────────────────────────────────────────────────────┐
│ Agent Context Trimmer       Probe: latest ▾       Harness: TUI       Model: gpt-5.6-luna    │
│ Effective input: 17,938 tokens · 8,960 cached        [Capture smoke] [Original | Effective] │
├──────────────────────────────┬────────────────────────────────────────────┬───────────────────┤
│ INPUT COMPOSITION            │ CONTENT                                    │ TRANSFORMATION    │
│ [Payload order] [Largest]    │                                            │                   │
│                              │ AGENTS.md instructions                     │ Enabled      [●] │
│ ▼ Prewarm                    │ user · input_text · 7,206 chars            │                   │
│   Tools          28,544 ch   │                                            │ Operation         │
│   Base developer 17,730 ch   │ # AGENT INSTRUCTIONS                      │ Replace all     ▾ │
│                              │                                            │                   │
│ ▼ Inference request          │ The user, Bazyli (niieani), owns...        │ Find              │
│   Skills         21,448 ch   │ ...                                        │ [exact text      ]│
│   AGENTS.md       7,206 ch   │                                            │ Replace           │
│   Recommended     1,798 ch   │ [Rendered text] [Raw field] [Diff]         │ [replacement     ]│
│   Plugins         1,014 ch   │                                            │                   │
│   Apps              646 ch   │ Selection: 412 chars                       │ Matches: 1        │
│   Environment       428 ch   │ [Use selection as literal]                 │ Est. delta: -103  │
│   Permissions       362 ch   │                                            │                   │
│   Smoke prompt       28 ch   │                                            │ [Preview] [Save]  │
└──────────────────────────────┴────────────────────────────────────────────┴───────────────────┘
```

The global catalog supports comparison across captured conditions:

```text
┌────────────────────────────────────────────────────────────────────────────────────────────┐
│ CONTEXT CATALOG             Model: All ▾   Harness: All ▾   Project: All ▾   [New Probe] │
├──────────────────────────────────────┬──────────┬────────────┬──────────┬───────────────────┤
│ PART                                 │ VARIANTS │ OBSERVED IN│ SIZE     │ GLOBAL POLICY     │
├──────────────────────────────────────┼──────────┼────────────┼──────────┼───────────────────┤
│ Codex base instructions              │    3     │ TUI, App   │ 4–6K tok│ Keep            ▾ │
│ developer · prewarm · input_text     │          │ luna, sol  │          │                   │
│ Skills instructions                  │    2     │ TUI, App   │ 5–7K tok│ Replace         ▾ │
│ Project instructions                 │    7     │ 4 projects │ 1–3K tok│ Project policy  ▾ │
│ functions.exec · opaque description  │    4     │ TUI, App   │ 6–9K tok│ Keep            ▾ │
│ functions.wait · structured tool     │    1     │ TUI, App   │ ~300 tok│ Delete          ▾ │
└──────────────────────────────────────┴──────────┴────────────┴──────────┴───────────────────┘
```

Diagnostics expose the original NDJSON event stream and raw JSON, but they are secondary navigation.

## Implementation plan

1. **Domain and capture metadata**
   - Normalize harness identity from `Originator` and `User-Agent` without persisting headers.
   - Extend captured client events with original/effective payloads, harness metadata, and applied-rule results.
   - Reconstruct linked `response.create` requests and aggregate usage into Snapshots.
2. **Transformation engine**
   - Implement immutable traversal of structured text-bearing leaves.
   - Implement delete-part, literal replace, replace-all, and bounded-regexp operations.
   - Add deterministic scope matching, rule ordering, cardinality checks, digests, and explicit failures.
3. **Persistence and local API**
   - Persist versioned Transformation Sets as local JSON.
   - Expose capture catalog, snapshot detail, transformations, previews, and updates through reserved local API routes.
   - Keep the OpenAI proxy surface a transparent passthrough outside reserved routes.
4. **UI**
   - Build React/Tailwind screens with TanStack Router and TanStack Query.
   - Provide the Context Catalog, Snapshot inspector, opaque content reader, transformation editor, preview diff, and applicability state.
5. **Verification**
   - Unit-test classification, reconstruction, selectors, mutation operations, rule layering, drift, and persistence.
   - Integration-test HTTP and WebSocket rewriting while proving OAuth headers remain passthrough-only.
   - Drive the local interface in Chrome at desktop and narrow widths.
   - Run a real OAuth Codex Probe through the proxy with a unique injected instruction and verify both the model response and capture audit.
