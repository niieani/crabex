import type { TransformationExecution } from "../context/transformation.ts";
import type { HarnessIdentity } from "../context/harness.ts";

export type CaptureTransport = "http" | "websocket";
export type CaptureDirection = "client_to_upstream" | "upstream_to_client";
export type CaptureEncoding = "utf8" | "base64";

export interface CaptureEvent {
  sessionId: string;
  sequence: number;
  timestamp: string;
  transport: CaptureTransport;
  direction: CaptureDirection;
  encoding: CaptureEncoding;
  payload: string;
  effectivePayload?: string;
  transformationExecutions?: TransformationExecution[];
  harness?: HarnessIdentity;
  project?: string;
}

export interface CaptureSink {
  record(event: CaptureEvent): Promise<void>;
}
