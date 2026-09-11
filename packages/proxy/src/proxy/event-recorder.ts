import type {
  CaptureDirection,
  CaptureEncoding,
  CaptureEvent,
  CaptureRequestSummary,
  CaptureRouting,
  CaptureSink,
  CaptureTransport,
} from "../recording/capture.ts";
import { CaptureRetention } from "../recording/capture-retention.ts";
import { observePayload } from "../recording/payload-observation.ts";
import type { StatsStore } from "../recording/stats-store.ts";
import type { HarnessIdentity } from "../context/harness.ts";
import { transformResponseCreate, type ResponseCreatePayload } from "../context/transform.ts";
import type { Transformation, TransformationExecution } from "../context/transformation.ts";

export class EventRecorder {
  #sequence = 0;
  readonly #retention = new CaptureRetention();
  readonly #sessionId: string;
  readonly #sink: CaptureSink;
  readonly #now: () => Date;
  readonly #stats?: StatsStore;

  constructor(
    sink: CaptureSink,
    now: () => Date,
    createSessionId: () => string,
    stats?: StatsStore,
  ) {
    this.#sink = sink;
    this.#now = now;
    this.#sessionId = createSessionId();
    this.#stats = stats;
  }

  async record(
    transport: CaptureTransport,
    direction: CaptureDirection,
    value: string | ArrayBuffer | Uint8Array,
    encoding: CaptureEncoding,
    metadata: {
      effectivePayload?: string;
      requestSummary?: CaptureRequestSummary;
      transformationChanged?: boolean;
      transformationExecutions?: TransformationExecution[];
      harness?: HarnessIdentity;
      project?: string;
      routing?: CaptureRouting;
    } = {},
  ): Promise<void> {
    const payload =
      typeof value === "string"
        ? value
        : bufferFrom(value).toString(encoding === "base64" ? "base64" : "utf8");
    const observation = observePayload(payload, direction);
    const requestSummary = metadata.requestSummary ?? observation.requestSummary;
    const mode = this.#retention.modeFor(requestSummary, observation.sessionKey);
    const common = {
      sessionId: this.#sessionId,
      sequence: ++this.#sequence,
      timestamp: this.#now().toISOString(),
      transport,
      direction,
      encoding,
      ...(metadata.transformationChanged === undefined
        ? {}
        : { transformationChanged: metadata.transformationChanged }),
      ...(metadata.transformationExecutions === undefined
        ? {}
        : { transformationExecutions: metadata.transformationExecutions }),
      ...(metadata.harness === undefined ? {} : { harness: metadata.harness }),
      ...(metadata.project === undefined ? {} : { project: metadata.project }),
      ...(metadata.routing === undefined ? {} : { routing: metadata.routing }),
    };
    const event: CaptureEvent =
      mode === "full"
        ? {
            ...common,
            payloadMode: "full",
            payload,
            ...(metadata.effectivePayload === undefined
              ? {}
              : { effectivePayload: metadata.effectivePayload }),
          }
        : {
            ...common,
            payloadMode: "metadata",
            payloadBytes:
              typeof value === "string" ? Buffer.byteLength(value) : bufferFrom(value).byteLength,
            ...(observation.eventType === undefined ? {} : { eventType: observation.eventType }),
            ...(requestSummary === undefined ? {} : { requestSummary }),
            ...(observation.responseSummary === undefined
              ? {}
              : { responseSummary: observation.responseSummary }),
          };
    // Telemetry counters are recorded at event time so they survive capture
    // rotation and retention latching; a stats failure must not break capture.
    try {
      if (metadata.transformationExecutions !== undefined) {
        this.#stats?.recordTransformations(metadata.transformationExecutions, common.timestamp);
      }
      if (metadata.routing !== undefined) {
        this.#stats?.recordRouting(metadata.routing, common.timestamp);
      }
    } catch {
      // stats are best-effort
    }
    try {
      await this.#sink.record(event);
    } catch (error) {
      throw new CaptureFailure(error);
    }
  }
}

export function processClientPayload(
  value: string | ArrayBuffer | Uint8Array,
  encoding: CaptureEncoding,
  transformations: Transformation[],
  harness: HarnessIdentity,
  project: string | undefined,
): {
  value: string | ArrayBuffer | Uint8Array;
  effectivePayload?: string;
  requestSummary?: CaptureRequestSummary;
  transformationChanged?: boolean;
  transformationExecutions?: TransformationExecution[];
} {
  if (encoding !== "utf8") return { value };
  const original = typeof value === "string" ? value : bufferFrom(value).toString("utf8");
  let payload: ResponseCreatePayload;
  try {
    payload = JSON.parse(original) as ResponseCreatePayload;
  } catch {
    return { value };
  }
  if (payload === null || typeof payload !== "object" || payload.type !== "response.create") {
    return { value };
  }
  const requestSummary = observePayload(original, "client_to_upstream").requestSummary;
  if (transformations.length === 0) return { value, requestSummary };
  const result = transformResponseCreate(payload, transformations, { harness, project });
  const effectivePayload = JSON.stringify(result.payload);
  const changed = effectivePayload !== original;
  return {
    value: changed ? effectivePayload : value,
    requestSummary,
    transformationChanged: changed,
    ...(changed ? { effectivePayload } : {}),
    transformationExecutions: result.executions,
  };
}

export class CaptureFailure extends Error {
  constructor(cause: unknown) {
    super("capture failed", { cause });
  }
}

function bufferFrom(value: ArrayBuffer | Uint8Array): Buffer {
  return value instanceof ArrayBuffer
    ? Buffer.from(value)
    : Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}
