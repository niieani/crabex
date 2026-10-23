import { mkdtemp, readdir, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vite-plus/test";

import { pruneCaptures } from "./capture-pruning.ts";
import { openRotatingCaptureSink } from "./ndjson-capture-sink.ts";
import type { CaptureEvent } from "./capture.ts";

const DAY = 86_400_000;
const NOW = Date.parse("2026-10-22T12:00:00.000Z");

async function capture(directory: string, name: string, bytes: number, ageDays: number) {
  const path = join(directory, name);
  await writeFile(path, "x".repeat(bytes));
  const time = new Date(NOW - ageDays * DAY);
  await utimes(path, time, time);
}

describe("pruneCaptures", () => {
  it("deletes expired captures, then the oldest beyond the size cap, never the live one", async () => {
    const directory = await mkdtemp(join(tmpdir(), "crabex-prune-"));
    await capture(directory, "expired.ndjson", 10, 9);
    await capture(directory, "old.ndjson", 60, 3);
    await capture(directory, "recent.ndjson", 30, 1);
    await capture(directory, "live.ndjson", 40, 20);
    await writeFile(join(directory, "notes.txt"), "kept");

    const deleted = await pruneCaptures(
      directory,
      { maxAgeDays: 7, maxTotalBytes: 100 },
      { keep: "live.ndjson", now: NOW },
    );

    expect(deleted).toEqual(["expired.ndjson", "old.ndjson"]);
    expect((await readdir(directory)).sort()).toEqual([
      "live.ndjson",
      "notes.txt",
      "recent.ndjson",
    ]);
  });
});

describe("openRotatingCaptureSink", () => {
  it("starts a new file on a new UTC day and past the size limit", async () => {
    const directory = await mkdtemp(join(tmpdir(), "crabex-rotate-"));
    let now = new Date("2026-10-22T23:59:00.000Z");
    const sink = await openRotatingCaptureSink(directory, {
      retention: { maxAgeDays: 7, maxTotalBytes: 1024 * 1024 },
      maxFileBytes: 400,
      now: () => now,
    });
    const event = (sequence: number) =>
      ({
        sessionId: "session",
        sequence,
        timestamp: now.toISOString(),
        transport: "websocket",
        direction: "upstream_to_client",
        encoding: "utf8",
        payloadMode: "metadata",
        payloadBytes: 1,
      }) satisfies CaptureEvent;

    await sink.record(event(1));
    await sink.record(event(2));
    now = new Date("2026-10-23T00:00:01.000Z");
    await sink.record(event(3));
    for (let sequence = 4; sequence < 8; sequence += 1) await sink.record(event(sequence));
    await sink.close();

    const names = (await readdir(directory)).sort();
    expect(names).toHaveLength(3);
    expect(names[0]).toMatch(/^2026-10-22T23-59-00\.000Z-/);
    expect(names[1]).toMatch(/^2026-10-23T00-00-01\.000Z-/);
  });
});
