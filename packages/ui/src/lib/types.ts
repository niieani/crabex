export type HarnessKind = "desktop" | "tui" | "unknown" | "conflicted";

export interface HarnessIdentity {
  kind: HarnessKind;
  version?: string;
  build?: string;
}

export interface ContextPart {
  id: string;
  phase: "prewarm" | "inference";
  kind: "message" | "tool";
  role?: string;
  name: string;
  path: string;
  text: string;
  characters: number;
  estimatedTokens: number;
  digest: string;
  identifier?: string;
  description?: string;
  json?: string;
  sections?: ContextSection[];
  originalText?: string;
  originalDescription?: string;
  originalJson?: string;
  deleted?: boolean;
}

export interface ContextSection {
  identifier: string;
  label: string;
  kind: "heading" | "skill" | "tool" | "mcp" | "tool_group";
  text: string;
  characters: number;
  estimatedTokens: number;
  children: ContextSection[];
  originalText?: string;
  deleted?: boolean;
}

export interface ContextSnapshot {
  id: string;
  sessionId: string;
  timestamp: string;
  model: string;
  harness: HarnessIdentity;
  project?: string;
  requestSequences: number[];
  parts: ContextPart[];
  usage?: { inputTokens: number; cachedTokens: number };
}

export interface Transformation {
  id: string;
  name: string;
  enabled: boolean;
  scope: {
    harnesses?: HarnessKind[];
    models?: string[];
    projects?: string[];
    segments?: string[];
    tools?: string[];
  };
  target: {
    field: "message_text" | "tool_description" | "json_value" | "all_text" | "tool";
    path?: string;
    toolName?: string;
    identifier?: string;
    variantDigest?: string;
    jsonPath?: JsonPathSegment[];
  };
  operation:
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
}

export type JsonPathSegment = string | number;

export interface TransformationSet {
  version: 1;
  transformations: Transformation[];
}

export interface TransformationTelemetry {
  transformationId: string;
  hits: number;
  misses: number;
  errors: number;
  matchCount: number;
  lastRunAt: string;
}
