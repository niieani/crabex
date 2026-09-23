import type { TransformationExecution } from "../context/transformation.ts";
import type { HarnessIdentity } from "../context/harness.ts";

export type CaptureTransport = "http" | "websocket";
export type CaptureDirection = "client_to_upstream" | "upstream_to_client";
export type CaptureEncoding = "utf8" | "base64";

export interface CaptureUsage {
  inputTokens: number;
  cachedTokens: number;
}

export interface CaptureMessageObservation {
  path: string;
  role?: string;
  classificationId?: string;
  classificationLabel?: string;
  characters: number;
}

export interface CaptureRequestSummary {
  type: "response.create";
  model?: string;
  generate?: boolean;
  previousResponseId?: string;
  messages: CaptureMessageObservation[];
  hasRealUserMessage: boolean;
}

export interface CaptureResponseSummary {
  type: "response.completed";
  id?: string;
  previousResponseId?: string;
  usage?: CaptureUsage;
}

/** Compact diagnostic from `error` / `response.failed` — kept after retention latches. */
export interface CaptureErrorSummary {
  eventType: string;
  status?: number;
  code?: string;
  message?: string;
  model?: string;
}

/**
 * Where an upstream-to-client event actually came from. Distinguishes a
 * routed gateway SSE stream from a ChatGPT websocket/HTTP passthrough.
 */
export interface CaptureUpstreamOrigin {
  kind: "gateway-http" | "gateway-websocket" | "chatgpt-http" | "chatgpt-websocket";
  url: string;
}

export interface CaptureRoutingAttempt {
  upstreamModel: string;
  outcome: "served" | "retry" | "failover" | "fatal" | "breaker-open" | "network-error";
  status?: number;
  /** Wall-clock time the attempt took, including draining the error body. */
  durationMs?: number;
}

export interface CaptureRouting {
  action: "routed" | "bundle-override" | "models-advertised";
  routeSlugs?: string[];
  /** Tool declaration types omitted by the route policy before forwarding. */
  omittedToolTypes?: string[];
  upstream?: string;
  requestedModel?: string;
  upstreamModel?: string;
  /** Per-attempt trail for routed requests, in order; the last entry served or failed. */
  attempts?: CaptureRoutingAttempt[];
}

interface CaptureEventBase {
  sessionId: string;
  sequence: number;
  timestamp: string;
  transport: CaptureTransport;
  direction: CaptureDirection;
  encoding: CaptureEncoding;
  transformationExecutions?: TransformationExecution[];
  transformationChanged?: boolean;
  harness?: HarnessIdentity;
  project?: string;
  routing?: CaptureRouting;
  origin?: CaptureUpstreamOrigin;
  errorSummary?: CaptureErrorSummary;
}

export interface FullCaptureEvent extends CaptureEventBase {
  payloadMode?: "full";
  payload: string;
  effectivePayload?: string;
}

export interface MetadataCaptureEvent extends CaptureEventBase {
  payloadMode: "metadata";
  payloadBytes: number;
  eventType?: string;
  requestSummary?: CaptureRequestSummary;
  responseSummary?: CaptureResponseSummary;
}

export type CaptureEvent = FullCaptureEvent | MetadataCaptureEvent;

export interface CaptureSink {
  record(event: CaptureEvent): Promise<void>;
}
