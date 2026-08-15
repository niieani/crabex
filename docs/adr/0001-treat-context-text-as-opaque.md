# Treat context text as opaque

Superseded in part by ADR 0002.

Context Parts are identified from the structured Responses payload, but their prose is never parsed to infer semantic subsections. Transformations are explicit whole-part, literal, or bounded-regexp operations with visible match cardinality and drift; this avoids coupling the product to dynamically generated, model-specific, or harness-specific English and tool documentation.
