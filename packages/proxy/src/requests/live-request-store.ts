import { randomUUID } from "node:crypto";

export type LiveRequestState =
  | "routing"
  | "connecting"
  | "retrying"
  | "falling-back"
  | "streaming"
  | "completed"
  | "failed";

export interface LiveRequestEvent {
  at: string;
  state: LiveRequestState;
  targetModel?: string;
  attempt?: number;
  status?: number;
  detail?: string;
}

export interface LiveRequest {
  id: string;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  state: LiveRequestState;
  transport: "http" | "websocket";
  requestedModel?: string;
  routeSlug?: string;
  upstream: string;
  targetModel?: string;
  targetIndex?: number;
  attempt?: number;
  maxAttempts?: number;
  status?: number;
  detail?: string;
  events: LiveRequestEvent[];
}

export type LiveRequestStart = Pick<
  LiveRequest,
  "transport" | "requestedModel" | "routeSlug" | "upstream" | "targetModel"
>;

export type LiveRequestUpdate = Partial<
  Pick<
    LiveRequest,
    "state" | "targetModel" | "targetIndex" | "attempt" | "maxAttempts" | "status" | "detail"
  >
>;

/** Volatile request activity for the local UI; no prompts or response bodies are retained. */
export class LiveRequestStore {
  readonly #requests = new Map<string, LiveRequest>();
  readonly #now: () => Date;
  readonly #createId: () => string;
  readonly #retentionMs: number;

  constructor(options: { now?: () => Date; createId?: () => string; retentionMs?: number } = {}) {
    this.#now = options.now ?? (() => new Date());
    this.#createId = options.createId ?? randomUUID;
    this.#retentionMs = options.retentionMs ?? 60_000;
  }

  start(input: LiveRequestStart): string {
    this.#prune();
    const id = this.#createId();
    const at = this.#now().toISOString();
    const event: LiveRequestEvent = {
      at,
      state: "routing",
      ...(input.targetModel === undefined ? {} : { targetModel: input.targetModel }),
    };
    this.#requests.set(id, {
      id,
      startedAt: at,
      updatedAt: at,
      state: "routing",
      ...input,
      events: [event],
    });
    return id;
  }

  update(id: string, update: LiveRequestUpdate): void {
    const current = this.#requests.get(id);
    if (current === undefined || current.completedAt !== undefined) return;
    const at = this.#now().toISOString();
    const next = { ...current, ...update, updatedAt: at };
    const event: LiveRequestEvent = {
      at,
      state: next.state,
      ...(next.targetModel === undefined ? {} : { targetModel: next.targetModel }),
      ...(next.attempt === undefined ? {} : { attempt: next.attempt }),
      ...(update.status === undefined ? {} : { status: update.status }),
      ...(update.detail === undefined ? {} : { detail: update.detail }),
    };
    next.events = [...current.events, event].slice(-20);
    this.#requests.set(id, next);
  }

  finish(id: string, update: LiveRequestUpdate & { state: "completed" | "failed" }): void {
    const current = this.#requests.get(id);
    if (current === undefined || current.completedAt !== undefined) return;
    this.update(id, update);
    const next = this.#requests.get(id);
    if (next !== undefined) this.#requests.set(id, { ...next, completedAt: next.updatedAt });
  }

  snapshot(): { active: LiveRequest[]; recent: LiveRequest[] } {
    this.#prune();
    const requests = [...this.#requests.values()].sort((a, b) =>
      b.startedAt.localeCompare(a.startedAt),
    );
    return {
      active: requests.filter((request) => request.completedAt === undefined).map(cloneRequest),
      recent: requests.filter((request) => request.completedAt !== undefined).map(cloneRequest),
    };
  }

  #prune(): void {
    const cutoff = this.#now().getTime() - this.#retentionMs;
    for (const [id, request] of this.#requests) {
      if (request.completedAt !== undefined && Date.parse(request.completedAt) < cutoff) {
        this.#requests.delete(id);
      }
    }
  }
}

function cloneRequest(request: LiveRequest): LiveRequest {
  return { ...request, events: request.events.map((event) => ({ ...event })) };
}
