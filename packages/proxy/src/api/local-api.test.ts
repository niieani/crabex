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
        tokenization: { encoding: "o200k_base", fallback: false },
        harness: { kind: "tui", version: "0.146.0" },
        requestSequences: [1, 2],
        parts: [],
      },
    ];
    const api = createLocalApi({
      snapshots: {
        list: async () => snapshots,
        preview: async (id, transformations) => ({
          ...snapshots[0]!,
          id,
          parts: transformations.length === 0 ? [] : snapshots[0]!.parts,
        }),
        transformationTelemetry: async () => [
          {
            transformationId: "rule-1",
            hits: 2,
            misses: 1,
            errors: 0,
            matchCount: 4,
            lastRunAt: "2026-08-15T00:00:00.000Z",
          },
        ],
      },
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

    const telemetry = await api.handle(
      new Request("http://localhost/__agent-context-trimmer/api/transformation-telemetry"),
    );
    expect(await telemetry?.json()).toEqual({
      telemetry: [
        {
          transformationId: "rule-1",
          hits: 2,
          misses: 1,
          errors: 0,
          matchCount: 4,
          lastRunAt: "2026-08-15T00:00:00.000Z",
        },
      ],
    });

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
        },
      ],
    };
    const preview = await api.handle(
      new Request("http://localhost/__agent-context-trimmer/api/preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ snapshotId: "session:2", transformations: next.transformations }),
      }),
    );
    expect(preview?.status).toBe(200);
    expect(await preview?.json()).toMatchObject({ snapshot: { id: "session:2" } });

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
      snapshots: {
        list: async () => [],
        preview: async () => undefined,
        transformationTelemetry: async () => [],
      },
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
