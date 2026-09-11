import type { CaptureRequestSummary } from "./capture.ts";

export type CaptureMode = "full" | "metadata";

/**
 * Retention latch: full payloads until a session's first real user message,
 * metadata-only afterwards. Latching is per codex thread (`thread_id`, falling
 * back to `session_id`), so every conversation's opening prompt stays
 * inspectable in the context catalog while later turns — which mostly repeat
 * that context — don't retain user content.
 *
 * Events without a session key (response streams, HTTP requests, anything
 * unattributable) share a global latch that any real user message flips, so
 * verbose response traffic still collapses to metadata after the first real
 * prompt anywhere.
 */
export class CaptureRetention {
  #latchedSessions = new Set<string>();
  #globalLatched = false;

  modeFor(request: CaptureRequestSummary | undefined, sessionKey?: string): CaptureMode {
    const latched =
      sessionKey === undefined ? this.#globalLatched : this.#latchedSessions.has(sessionKey);
    if (request?.hasRealUserMessage === true) {
      if (sessionKey !== undefined) this.#latchedSessions.add(sessionKey);
      this.#globalLatched = true;
    }
    return latched ? "metadata" : "full";
  }
}
