import type { HarnessKind } from "./harness.ts";

export interface Transformation {
  id: string;
  name: string;
  enabled: boolean;
  scope: TransformationScope;
  target: TransformationTarget;
  operation: TransformationOperation;
  cardinality: MatchCardinality;
}

export interface TransformationScope {
  harnesses?: HarnessKind[];
  models?: string[];
  projects?: string[];
}

export interface TransformationTarget {
  field: "message_text" | "tool_description" | "all_text" | "tool";
  path?: string;
  toolName?: string;
  variantDigest?: string;
}

export type TransformationOperation =
  | { type: "delete_part" }
  | { type: "replace"; find: string; replacement: string }
  | { type: "replace_all"; find: string; replacement: string }
  | {
      type: "regex";
      pattern: string;
      replacement: string;
      flags: string;
      replaceAll: boolean;
    };

export interface MatchCardinality {
  min: number;
  max?: number;
}

export interface AppliedTransformation {
  transformationId: string;
  matchCount: number;
}

export interface TransformationSet {
  version: 1;
  transformations: Transformation[];
}
