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
}

export interface CaptureSink {
  record(event: CaptureEvent): Promise<void>;
}
