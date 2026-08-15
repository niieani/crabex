import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vite-plus/test";

import type { CaptureEvent } from "./capture.ts";
import { FileCaptureRepository } from "./capture-repository.ts";

describe("file capture repository", () => {
  it("builds snapshots across capture files and tolerates an unfinished trailing line", async () => {
    const directory = await mkdtemp(join(tmpdir(), "act-captures-"));
    const events = [
      event(1, "client_to_upstream", {
        type: "response.create",
        model: "gpt-5.6-luna",
        input: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "hi" }],
          },
        ],
      }),
      event(2, "upstream_to_client", {
        type: "response.completed",
        response: { id: "resp_1", usage: { input_tokens: 12 } },
      }),
    ];
    await writeFile(
      join(directory, "capture.ndjson"),
      `${events.map((value) => JSON.stringify(value)).join("\n")}\n{"unfinished"`,
    );

    const snapshots = await new FileCaptureRepository(directory).list();

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({ model: "gpt-5.6-luna", usage: { inputTokens: 12 } });
  });

  it("aggregates hit, miss, and error executions by transformation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "act-captures-"));
    const first = event(1, "client_to_upstream", { type: "response.create" });
    first.transformationExecutions = [
      { transformationId: "trim", status: "hit", matchCount: 3 },
      { transformationId: "optional", status: "miss", matchCount: 0 },
    ];
    const second = event(2, "client_to_upstream", { type: "response.create" });
    second.transformationExecutions = [
      { transformationId: "trim", status: "miss", matchCount: 0 },
      {
        transformationId: "optional",
        status: "error",
        matchCount: 0,
        error: "invalid expression",
      },
    ];
    await writeFile(
      join(directory, "capture.ndjson"),
      `${JSON.stringify(first)}\n${JSON.stringify(second)}\n`,
    );

    const telemetry = await new FileCaptureRepository(directory).transformationTelemetry();

    expect(telemetry).toEqual([
      {
        transformationId: "optional",
        hits: 0,
        misses: 1,
        errors: 1,
        matchCount: 0,
        lastRunAt: second.timestamp,
      },
      {
        transformationId: "trim",
        hits: 1,
        misses: 1,
        errors: 0,
        matchCount: 3,
        lastRunAt: second.timestamp,
      },
    ]);
  });
});

function event(
  sequence: number,
  direction: CaptureEvent["direction"],
  payload: unknown,
): CaptureEvent {
  return {
    sessionId: "session",
    sequence,
    timestamp: new Date(sequence * 1000).toISOString(),
    transport: "websocket",
    direction,
    encoding: "utf8",
    payload: JSON.stringify(payload),
  };
}
