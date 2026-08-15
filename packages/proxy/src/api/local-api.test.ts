import { describe, expect, it } from "vite-plus/test";

import type { ContextSnapshot } from "../context/snapshot.ts";
import type { TransformationSet } from "../context/transformation.ts";
import { createLocalApi } from "./local-api.ts";

describe("local context API", () => {
  it("serves snapshots and updates transformations", async () => {
    let set: TransformationSet = { version: 1, transformations: [] };
    const snapshots: ContextSnapshot[] = [
      {
        id: "session:2",
        sessionId: "session",
        timestamp: "2026-08-15T00:00:00.000Z",
        model: "gpt-5.6-luna",
        harness: { kind: "tui", version: "0.146.0" },
        requestSequences: [1, 2],
        parts: [],
      },
    ];
    const api = createLocalApi({
      snapshots: { list: async () => snapshots },
      transformations: {
        get: () => set,
        replace: async (next) => {
          set = next;
        },
      },
    });

    const response = await api.handle(
      new Request("http://localhost/__agent-context-trimmer/api/snapshots"),
    );
    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({ snapshots });

    const next: TransformationSet = {
      version: 1,
      transformations: [
        {
          id: "rule-1",
          name: "Rule one",
          enabled: true,
          scope: {},
          target: { field: "message_text" },
          operation: { type: "replace_all", find: "before", replacement: "after" },
          cardinality: { min: 0 },
        },
      ],
    };
    const update = await api.handle(
      new Request("http://localhost/__agent-context-trimmer/api/transformations", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(next),
      }),
    );
    expect(update?.status).toBe(200);
    expect(set).toEqual(next);
  });

  it("returns undefined outside the reserved API surface", async () => {
    const api = createLocalApi({
      snapshots: { list: async () => [] },
      transformations: {
        get: () => ({ version: 1, transformations: [] }),
        replace: async () => {},
      },
    });

    expect(await api.handle(new Request("http://localhost/backend-api/codex/responses"))).toBe(
      undefined,
    );
  });
});
