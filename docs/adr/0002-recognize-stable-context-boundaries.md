# Recognize stable context boundaries

Supersedes ADR 0001’s blanket prohibition on parsing Context Part text.

Unknown prose remains opaque. The app does recognize exact, stable boundaries already emitted by the harness: known message prefixes and pseudo-XML wrappers, ATX Markdown headings, backticked tool headings, and one-line skill entries. These produce stable identifiers that can be displayed and targeted without interpreting the English inside them.

Structured tool definitions and `client_metadata.x-codex-turn-metadata.code_mode_tool_names` remain the authoritative sources for function and MCP identity. Disabling an identified tool removes every recognized declaration of that identifier that is present in the request.

Classification is additive and best-effort. An unknown wrapper or changed Markdown shape remains visible as an opaque Context Part and can still be transformed by path, literal text, or regexp. A classifier miss never blocks forwarding.
