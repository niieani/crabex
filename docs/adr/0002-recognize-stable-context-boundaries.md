# Recognize stable context boundaries

Supersedes ADR 0001’s blanket prohibition on parsing Context Part text.

Unknown prose remains opaque. The app does recognize exact, stable boundaries already emitted by the harness: known message prefixes and pseudo-XML wrappers, ATX Markdown headings, backticked tool headings, and one-line skill entries. These produce stable identifiers that can be displayed and targeted without interpreting the English inside them.

Structured tool definitions and `client_metadata.x-codex-turn-metadata.code_mode_tool_names` remain the authoritative sources for function and MCP identity. Disabling an identified tool removes every recognized declaration of that identifier that is present in the request.

Classification is additive and best-effort. An unknown wrapper or changed Markdown shape remains visible as an opaque Context Part and can still be transformed by path, literal text, or regexp. A classifier miss never blocks forwarding.

## Generated `functions.exec` descriptions

Codex constructs the `functions.exec` description by placing arbitrary tool-description Markdown beneath generated ``### `tool_name` `` headings. A nested description can therefore contain an H1 or H2 that would escape its generated H3 according to ordinary Markdown nesting.

For this Context Part, declaration footers—not raw heading levels—define tool blocks. The classifier recognizes a generated tool only when its backticked heading is paired with a matching `exec tool declaration:` TypeScript footer. It keeps every intervening heading beneath that tool by rebasing levels in the classification tree without changing source text or offsets. An H2 is recognized as a generated namespace only when the following verified tool name has the corresponding double-underscore prefix. Horizontal rules have no structural meaning here.

An unmatched candidate remains an ordinary Markdown heading; if no declaration footer is recognized, classification falls back completely to ordinary ATX Markdown handling. No tool name or description prose receives a one-off exception.
