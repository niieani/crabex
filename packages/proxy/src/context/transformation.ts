import type { HarnessKind } from "./harness.ts";

export interface Transformation {
  id: string;
  name: string;
  enabled: boolean;
  scope: TransformationScope;
  target: TransformationTarget;
  operation: TransformationOperation;
}

export interface TransformationScope {
  harnesses?: HarnessKind[];
  models?: string[];
  projects?: string[];
  segments?: string[];
  tools?: string[];
}

export interface TransformationTarget {
  field: "message_text" | "tool_description" | "all_text" | "tool";
  path?: string;
  toolName?: string;
  identifier?: string;
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

export interface TransformationExecution {
  transformationId: string;
  matchCount: number;
  status: "hit" | "miss" | "error";
  error?: string;
}

export interface TransformationTelemetry {
  transformationId: string;
  hits: number;
  misses: number;
  errors: number;
  matchCount: number;
  lastRunAt: string;
}

export interface TransformationSet {
  version: 1;
  transformations: Transformation[];
}
