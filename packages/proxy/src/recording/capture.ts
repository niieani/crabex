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
