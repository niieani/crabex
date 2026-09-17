export type HarnessKind = "desktop" | "tui" | "unknown" | "conflicted";

export interface HarnessIdentity {
  kind: HarnessKind;
  version?: string;
  build?: string;
}

export interface ContextPart {
  id: string;
  phase: "prewarm" | "inference" | "model";
  kind: "message" | "tool";
  role?: string;
  name: string;
  path: string;
  text: string;
  characters: number;
  estimatedTokens: number;
  originalEstimatedTokens?: number;
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
  originalEstimatedTokens?: number;
  children: ContextSection[];
  originalText?: string;
  deleted?: boolean;
}

export interface CaptureRoutingAttempt {
  upstreamModel: string;
  outcome: "served" | "retry" | "failover" | "fatal" | "breaker-open" | "network-error";
  status?: number;
}

export interface CaptureRouting {
  action: "routed" | "bundle-override" | "models-advertised";
  routeSlugs?: string[];
  upstream?: string;
  requestedModel?: string;
  upstreamModel?: string;
  attempts?: CaptureRoutingAttempt[];
}

export interface CacheUsageStats {
  samples: number;
  inputTokens: number;
  cachedTokens: number;
}

export interface RouteTargetStats {
  attempts: number;
  served: number;
  failed: number;
  retries?: number;
  retriedRequests?: number;
  retryRecoveries?: number;
  failovers?: number;
  totalLatencyMs: number;
  avgLatencyMs?: number;
  lastStatus?: number;
  lastSeenAt: string;
  errorRate?: number;
  retrySuccessRate?: number;
  cacheHitRate?: number;
  cache?: CacheUsageStats;
}

export interface RoutingTelemetry {
  action: string;
  routeSlug?: string;
  count: number;
  lastSeenAt: string;
  served?: number;
  failed?: number;
  failovers?: number;
  errorRate?: number;
  avgLatencyMs?: number;
  cacheHitRate?: number;
  fallbackCacheHitRate?: number;
  cache?: CacheUsageStats;
  fallbackCache?: CacheUsageStats;
  targets?: Record<string, RouteTargetStats>;
}

export interface ContextSnapshot {
  id: string;
  sessionId: string;
  timestamp: string;
  model: string;
  tokenization: { encoding: "o200k_base"; fallback: boolean };
  harness: HarnessIdentity;
  project?: string;
  routing?: CaptureRouting;
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

export interface AdvertisedModelConfig {
  description: string;
  display_name: string;
  overrides?: Record<string, unknown>;
  priority: number;
  slug: string;
  template_slug: string;
}

export interface RouteTargetConfig {
  upstream_model?: string;
  attempts?: number;
}

export interface RouteRetryConfig {
  on_status?: number[];
  backoff_ms?: number[];
  breaker?: { failures?: number; cooldown_ms?: number };
}

export interface ModelRouteConfig {
  authorization_env: string;
  enabled?: boolean;
  model: AdvertisedModelConfig;
  upstream: string;
  upstream_model?: string;
  targets?: RouteTargetConfig[];
  retry?: RouteRetryConfig;
  transport?: "http" | "ws";
}

export interface ModelAdjustment {
  slug: string;
  overrides: Record<string, unknown>;
}

export interface ModelRouteSet {
  version: 1;
  routes: ModelRouteConfig[];
  adjustments?: ModelAdjustment[];
  fixture_pins?: string[];
}

export type ModelDefinition = Record<string, unknown> & { slug: string };

export interface ModelsFixture {
  models: ModelDefinition[];
}

export interface UpstreamObservation {
  fetchedAt: string;
  body: unknown;
}

export interface UpstreamCacheState {
  models?: UpstreamObservation;
  configBundle?: UpstreamObservation;
}

export interface ConfigBundleOverride {
  version: 1;
  enabled: boolean;
  bundle: unknown;
}

export interface CodexConfigToggle {
  key: string;
  label: string;
  description: string;
  managedValue: string;
  enabled: boolean;
  effectiveValue?: string;
  preservedValue?: string;
}

export interface CodexConfigState {
  path: string;
  exists: boolean;
  parseError?: string;
  toggles: CodexConfigToggle[];
}
