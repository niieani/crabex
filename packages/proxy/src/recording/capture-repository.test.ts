import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vite-plus/test";

import type { CaptureEvent, FullCaptureEvent } from "./capture.ts";
import { FileCaptureRepository } from "./capture-repository.ts";
import type { Transformation } from "../context/transformation.ts";

describe("file capture repository", () => {
  it("shares concurrent scans and restores the file index across restarts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relaydeck-cache-"));
    const path = join(directory, "snapshot-cache.json");
    const capture = join(directory, "capture.ndjson");
    await writeFile(
      capture,
      `${JSON.stringify(event(1, "client_to_upstream", { type: "response.create", model: "test", input: [message("user", "first")] }))}\n`,
    );
    const repository = new FileCaptureRepository(directory, {}, { path });
    const [first, concurrent] = await Promise.all([repository.list(), repository.list()]);
    expect(first).toBe(concurrent);
    await repository.flush();
    const cached = JSON.parse(await readFile(path, "utf8"));
    expect(cached.files).toEqual([
      ["capture.ndjson", expect.objectContaining({ snapshotIds: ["session:1"] })],
    ]);
    expect(cached.modelSignature).toEqual(expect.any(String));
    const restored = new FileCaptureRepository(directory, {}, { path });
    await restored.load();
    expect(await restored.list()).toEqual(first);
    await writeFile(
      capture,
      `${JSON.stringify(event(1, "client_to_upstream", { type: "response.create", model: "test", input: [message("user", "updated content")] }))}\n`,
    );
    expect((await restored.list())[0]?.parts[0]?.text).toBe("updated content");
    await restored.flush();
  });

  it("previews only the indexed capture even when another file cannot be parsed", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relaydeck-preview-"));
    await writeFile(
      join(directory, "z-target.ndjson"),
      `${JSON.stringify(event(1, "client_to_upstream", { type: "response.create", model: "test", input: [message("user", "hello")] }))}\n`,
    );
    const repository = new FileCaptureRepository(directory);
    await repository.list();
    await writeFile(join(directory, "a-unrelated.ndjson"), "invalid JSON\n");
    expect((await repository.preview("session:1", []))?.parts[0]?.text).toBe("hello");
  });

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

  it("caps snapshots per model/harness combo and overall", async () => {
    const directory = await mkdtemp(join(tmpdir(), "act-captures-"));
    // Five same-model sessions (one combo) plus two others.
    for (let session = 0; session < 5; session += 1) {
      await writeFile(
        join(directory, `capture-${session}.ndjson`),
        `${JSON.stringify(
          event(
            1,
            "client_to_upstream",
            {
              type: "response.create",
              model: "gpt-5.6-luna",
              input: [message("user", `prompt ${session}`)],
            },
            `s${session}`,
            new Date((session + 1) * 60_000).toISOString(),
          ),
        )}\n`,
      );
    }
    for (const [index, model] of ["gpt-5.6-sol", "gpt-5.6-terra"].entries()) {
      await writeFile(
        join(directory, `capture-${model}.ndjson`),
        `${JSON.stringify(
          event(
            1,
            "client_to_upstream",
            {
              type: "response.create",
              model,
              input: [message("user", "hi")],
            },
            model,
            new Date((index + 6) * 60_000).toISOString(),
          ),
        )}\n`,
      );
    }
    const repository = new FileCaptureRepository(directory, {}, { perCombo: 3, total: 50 });

    const snapshots = await repository.list();

    expect(snapshots).toHaveLength(5);
    expect(snapshots.filter((snapshot) => snapshot.model === "gpt-5.6-luna")).toHaveLength(3);
    // Newest win.
    expect(snapshots.map((snapshot) => snapshot.sessionId).sort()).toEqual([
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "s2",
      "s3",
      "s4",
    ]);
  });

  it("enforces the overall cap across combos", async () => {
    const directory = await mkdtemp(join(tmpdir(), "act-captures-"));
    for (let session = 0; session < 6; session += 1) {
      await writeFile(
        join(directory, `capture-${session}.ndjson`),
        `${JSON.stringify(
          event(
            1,
            "client_to_upstream",
            {
              type: "response.create",
              model: `model-${session}`,
              input: [message("user", "hi")],
            },
            `s${session}`,
            new Date((session + 1) * 60_000).toISOString(),
          ),
        )}\n`,
      );
    }
    const repository = new FileCaptureRepository(directory, {}, { perCombo: 3, total: 4 });

    const snapshots = await repository.list();

    expect(snapshots.map((snapshot) => snapshot.sessionId)).toEqual(["s5", "s4", "s3", "s2"]);
  });

  it("loads the disk cache on boot and saves it when idle", async () => {
    const directory = await mkdtemp(join(tmpdir(), "act-captures-"));
    const cachePath = join(directory, "snapshot-cache.json");
    await writeFile(
      join(directory, "capture.ndjson"),
      `${JSON.stringify(
        event(1, "client_to_upstream", {
          type: "response.create",
          model: "gpt-5.6-luna",
          input: [message("user", "hi")],
        }),
      )}\n`,
    );
    const first = new FileCaptureRepository(directory, {}, { path: cachePath });
    expect((await first.list()).map((snapshot) => snapshot.model)).toEqual(["gpt-5.6-luna"]);
    await first.flush();
    expect(JSON.parse(await readFile(cachePath, "utf8"))).toMatchObject({
      version: 1,
      snapshots: [{ model: "gpt-5.6-luna" }],
    });

    // A fresh repository over an EMPTY captures dir still serves the cache.
    const empty = await mkdtemp(join(tmpdir(), "act-captures-empty-"));
    const restored = new FileCaptureRepository(empty, {}, { path: cachePath });
    await restored.load();
    expect((await restored.list()).map((snapshot) => snapshot.model)).toEqual(["gpt-5.6-luna"]);
  });

  it("previews current transformations against an immutable historical snapshot", async () => {
    const directory = await mkdtemp(join(tmpdir(), "act-captures-"));
    const events = [
      event(1, "client_to_upstream", {
        type: "response.create",
        model: "gpt-5.6-luna",
        input: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "before" }],
          },
        ],
      }),
    ];
    await writeFile(join(directory, "capture.ndjson"), `${JSON.stringify(events[0])}\n`);
    const transformations: Transformation[] = [
      {
        id: "rewrite",
        name: "Rewrite",
        enabled: true,
        scope: {},
        target: { field: "message_text" },
        operation: { type: "replace_all", find: "before", replacement: "after" },
      },
    ];

    const preview = await new FileCaptureRepository(directory).preview(
      "session:1",
      transformations,
    );

    expect(preview?.parts[0]).toMatchObject({ text: "after", originalText: "before" });
    expect(JSON.parse(events[0]!.payload)).toMatchObject({
      input: [{ content: [{ text: "before" }] }],
    });
  });

  it("derives model parts from the upstream cache through routes and transformations", async () => {
    const directory = await mkdtemp(join(tmpdir(), "act-captures-"));
    await writeFile(
      join(directory, "capture.ndjson"),
      `${JSON.stringify(
        event(1, "client_to_upstream", {
          type: "response.create",
          model: "gpt-5.6-luna",
          input: [message("user", "hi")],
        }),
      )}\n`,
    );
    const repository = new FileCaptureRepository(directory, {
      upstreamCache: {
        get: () => ({
          models: {
            fetchedAt: new Date(0).toISOString(),
            body: {
              models: [
                {
                  slug: "gpt-5.6-luna",
                  context_window: 272_000,
                  model_messages: {
                    instructions_template: "You are Codex, an agent based on GPT-5. Be helpful.",
                  },
                },
              ],
            },
          },
        }),
        observe: async () => {},
      },
      modelRoutes: {
        get: () => ({
          routes: [],
          adjustments: [{ slug: "gpt-5.6-luna", overrides: { context_window: 200_000 } }],
          fixture_pins: [],
        }),
        replace: async () => {},
      },
      transformations: {
        get: () => ({
          version: 1,
          transformations: [
            {
              id: "trim-base",
              name: "Trim base",
              enabled: true,
              scope: {},
              target: { field: "message_text", identifier: "segment:codex_base" },
              operation: { type: "replace_all", find: "Be helpful.", replacement: "Be terse." },
            },
          ],
        }),
        replace: async () => {},
      },
    });

    const snapshots = await repository.list();

    const modelPart = snapshots[0]?.parts.find((part) => part.phase === "model");
    expect(modelPart).toMatchObject({
      identifier: "segment:codex_base",
      text: "You are Codex, an agent based on GPT-5. Be terse.",
      originalText: "You are Codex, an agent based on GPT-5. Be helpful.",
    });
  });

  it("derives model parts for fixture-only models without an upstream observation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "act-captures-"));
    await writeFile(
      join(directory, "capture.ndjson"),
      `${JSON.stringify(
        event(1, "client_to_upstream", {
          type: "response.create",
          model: "gpt-6-astra",
          input: [message("user", "hi")],
        }),
      )}\n`,
    );
    const repository = new FileCaptureRepository(directory, {
      fixtureModels: [
        {
          slug: "gpt-6-astra",
          model_messages: {
            instructions_template: "You are Codex, an agent based on GPT-6. Be helpful.",
            guardian_v2: { classifier_instructions: "Classify every tool call." },
          },
        },
      ],
    });

    const snapshots = await repository.list();

    const modelParts = (snapshots[0]?.parts ?? []).filter((part) => part.phase === "model");
    expect(modelParts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          identifier: "segment:codex_base",
          text: "You are Codex, an agent based on GPT-6. Be helpful.",
        }),
        expect.objectContaining({
          path: "model_messages.guardian_v2.classifier_instructions",
          text: "Classify every tool call.",
        }),
      ]),
    );
  });

  it("diffs a pinned model's fixture version against the observed upstream original", async () => {
    const directory = await mkdtemp(join(tmpdir(), "act-captures-"));
    await writeFile(
      join(directory, "capture.ndjson"),
      `${JSON.stringify(
        event(1, "client_to_upstream", {
          type: "response.create",
          model: "gpt-5.6-luna",
          input: [message("user", "hi")],
        }),
      )}\n`,
    );
    const repository = new FileCaptureRepository(directory, {
      upstreamCache: {
        get: () => ({
          models: {
            fetchedAt: new Date(0).toISOString(),
            body: {
              models: [
                {
                  slug: "gpt-5.6-luna",
                  model_messages: { instructions_template: "You are Codex, upstream base." },
                },
              ],
            },
          },
        }),
        observe: async () => {},
      },
      fixtureModels: [
        {
          slug: "gpt-5.6-luna",
          model_messages: { instructions_template: "You are Codex, fixture base." },
        },
      ],
      modelRoutes: {
        get: () => ({ routes: [], adjustments: [], fixture_pins: ["gpt-5.6-luna"] }),
        replace: async () => {},
      },
    });

    const snapshots = await repository.list();

    const modelPart = snapshots[0]?.parts.find(
      (part) => part.phase === "model" && part.identifier === "segment:codex_base",
    );
    expect(modelPart).toMatchObject({
      text: "You are Codex, fixture base.",
      originalText: "You are Codex, upstream base.",
    });
  });

  it("keeps later messages aligned when a classified segment is deleted", async () => {
    const directory = await mkdtemp(join(tmpdir(), "act-captures-"));
    const captured = event(1, "client_to_upstream", {
      type: "response.create",
      input: [message("developer", "You are Codex, a coding agent."), message("user", "hi")],
    });
    await writeFile(join(directory, "capture.ndjson"), `${JSON.stringify(captured)}\n`);

    const preview = await new FileCaptureRepository(directory).preview("session:1", [
      {
        id: "disable-base",
        name: "Disable Codex base",
        enabled: true,
        scope: {},
        target: { field: "message_text", identifier: "segment:codex_base" },
        operation: { type: "delete_part" },
      },
    ]);

    expect(preview?.parts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          identifier: "segment:codex_base",
          originalText: "You are Codex, a coding agent.",
          text: "",
          deleted: true,
        }),
        expect.objectContaining({ text: "hi" }),
      ]),
    );
    expect(preview?.parts.find((part) => part.text === "hi")).not.toHaveProperty("originalText");
  });
});

function message(role: string, text: string) {
  return { type: "message", role, content: [{ type: "input_text", text }] };
}

function event(
  sequence: number,
  direction: CaptureEvent["direction"],
  payload: unknown,
  sessionId = "session",
  timestamp?: string,
): FullCaptureEvent {
  return {
    sessionId,
    sequence,
    timestamp: timestamp ?? new Date(sequence * 1000).toISOString(),
    transport: "websocket",
    direction,
    encoding: "utf8",
    payload: JSON.stringify(payload),
  };
}
