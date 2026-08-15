import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vite-plus/test";

import type { TransformationSet } from "../context/transformation.ts";
import { openTransformationStore } from "./transformation-store.ts";

describe("transformation store", () => {
  it("starts empty and atomically persists a versioned set", async () => {
    const directory = await mkdtemp(join(tmpdir(), "act-rules-"));
    const path = join(directory, "rules.json");
    const store = await openTransformationStore(path);
    const set: TransformationSet = {
      version: 1,
      transformations: [
        {
          id: "smoke",
          name: "Smoke rewrite",
          enabled: true,
          scope: {},
          target: { field: "message_text" },
          operation: { type: "replace", find: "hello", replacement: "transformed" },
        },
      ],
    };

    expect(store.get()).toEqual({ version: 1, transformations: [] });
    await store.replace(set);

    expect(store.get()).toEqual(set);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(set);
    expect((await openTransformationStore(path)).get()).toEqual(set);
  });

  it("rejects malformed persisted configuration", async () => {
    const directory = await mkdtemp(join(tmpdir(), "act-rules-"));
    const path = join(directory, "rules.json");
    await Bun.write(path, '{"version":2,"transformations":[]}');

    await expect(openTransformationStore(path)).rejects.toThrow("unsupported transformation set");
  });
});
