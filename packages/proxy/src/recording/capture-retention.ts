import type { CaptureRequestSummary } from "./capture.ts";

export type CaptureMode = "full" | "metadata";

export class CaptureRetention {
  #mode: CaptureMode = "full";

  modeFor(request: CaptureRequestSummary | undefined): CaptureMode {
    const mode = this.#mode;
    if (mode === "full" && request?.hasRealUserMessage === true) {
      this.#mode = "metadata";
    }
    return mode;
  }
}
