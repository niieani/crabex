import type { ContextPart } from "../../lib/types.ts";

export interface CollapsedParts {
  /** Parts with request-side twins of model parts removed. */
  parts: ContextPart[];
  /** Model part → the request parts it absorbed. */
  twins: Map<ContextPart, ContextPart[]>;
}

/**
 * Collapses request parts that are byte-identical to a model-layer part (same
 * identifier, same effective text, same original text). The model part is the
 * one worth editing — model-layer transformations rewrite the template for
 * every future request — so the rendered request instances fold into it.
 * Parts that diverge in any dimension stay visible side by side.
 */
export function collapseModelTwins(parts: ContextPart[]): CollapsedParts {
  const modelParts = parts.filter(
    (part) => part.phase === "model" && part.identifier !== undefined,
  );
  if (modelParts.length === 0) return { parts, twins: new Map() };
  const twins = new Map<ContextPart, ContextPart[]>();
  const kept: ContextPart[] = [];
  for (const part of parts) {
    const twin =
      part.phase === "model"
        ? undefined
        : modelParts.find(
            (candidate) =>
              candidate.identifier === part.identifier &&
              candidate.text === part.text &&
              (candidate.originalText ?? candidate.text) === (part.originalText ?? part.text),
          );
    if (twin === undefined) {
      kept.push(part);
      continue;
    }
    twins.set(twin, [...(twins.get(twin) ?? []), part]);
  }
  return { parts: kept, twins };
}
