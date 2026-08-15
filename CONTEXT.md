# Agent Context Trimmer

Agent Context Trimmer observes and transforms the effective context supplied by a Codex harness for an inference request.

## Language

**Probe**:
A deliberately small Codex invocation used to reveal the context supplied under a known model, harness, and project configuration.
_Avoid_: Test session, audit run

**Snapshot**:
The complete effective inference context reconstructed from the linked requests in one Probe.
_Avoid_: Session, capture file

**Context Part**:
A structurally identified message or tool-definition leaf present in a Snapshot. Known harness wrappers may give it a stable identifier; unknown content remains opaque.
_Avoid_: Prompt fragment

**Context Section**:
A recognized Markdown heading subtree, skill entry, or generated tool declaration inside a Context Part. Its identifier is mechanical; its prose is not interpreted.
_Avoid_: Semantic topic

**Tool Registry**:
The deduplicated set of code-mode tool names observed across the linked requests of a Snapshot. Names are grouped mechanically by their double-underscore namespace segments.
_Avoid_: Tool request, MCP session

**Tool Group**:
A Tool Registry namespace prefix whose members share complete double-underscore-delimited name segments. Disabling a Tool Group disables every current member matching that prefix.
_Avoid_: Tool category

**Variant**:
One exact observed value of a Context Part, identified by its content digest and observation conditions.
_Avoid_: Version

**Observation Conditions**:
The model, harness, harness version, and project configuration under which a Variant was captured.
_Avoid_: Environment

**Context Catalog**:
The union of Context Parts and Variants found in all available Snapshots.
_Avoid_: Global prompt

**Transformation**:
An ordered, best-effort mechanical operation that deletes a Context Part or replaces text in selected fields. A Transformation never blocks the proxied request.
_Avoid_: Semantic rewrite, optimizer

**Transformation Execution**:
The observed outcome of one eligible Transformation against one request: hit, miss, or error, with its match count.
_Avoid_: Validation, assertion

**Transformation Scope**:
The observation conditions and optional stable Codex segment or structured tool definition in which a Transformation is eligible to run. Scope limits where matching occurs; it does not identify the text being changed.
_Avoid_: Filter

**Effective Payload**:
The outbound payload produced after all applicable Transformations have run against an original payload.
_Avoid_: Edited capture

**Drift**:
A structurally familiar Context Part whose exact content is not a known Variant for a strict Transformation.
_Avoid_: Parse failure

**Harness**:
The Codex client that constructs the request context, currently Codex Desktop or Codex TUI.
_Avoid_: Originator, frontend
