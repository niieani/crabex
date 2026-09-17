import { describe, expect, it } from "vite-plus/test";

import { LiveRequestStore } from "./live-request-store.ts";

describe("LiveRequestStore", () => {
  it("tracks active lifecycle events and briefly retains completed requests", () => {
    let now = new Date("2026-09-17T12:00:00.000Z");
    const store = new LiveRequestStore({ now: () => now, createId: () => "request-1" });
    const id = store.start({
      transport: "http",
      requestedModel: "gpt-6-astra",
      routeSlug: "gpt-6-astra",
      upstream: "https://gateway.test/v1/responses",
      targetModel: "openai.gpt-6-astra-flex",
    });

    now = new Date("2026-09-17T12:00:01.000Z");
    store.update(id, { state: "retrying", attempt: 2, status: 429 });
    expect(store.snapshot().active[0]).toMatchObject({
      id,
      state: "retrying",
      attempt: 2,
      status: 429,
    });

    now = new Date("2026-09-17T12:00:02.000Z");
    store.finish(id, { state: "completed", status: 200 });
    expect(store.snapshot()).toMatchObject({ active: [], recent: [{ id, state: "completed" }] });

    now = new Date("2026-09-17T12:01:03.000Z");
    expect(store.snapshot()).toEqual({ active: [], recent: [] });
  });
});
