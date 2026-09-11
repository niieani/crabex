import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vite-plus/test";

import type { CaptureEvent, FullCaptureEvent } from "./capture.ts";
import { FileCaptureRepository } from "./capture-repository.ts";
import type { Transformation } from "../context/transformation.ts";

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

  it("aggregates routing decisions by action and route", async () => {
    const directory = await mkdtemp(join(tmpdir(), "act-captures-"));
    const routed = event(1, "client_to_upstream", { type: "response.create" });
    routed.routing = {
      action: "routed",
      routeSlugs: ["kimi-k3"],
      upstream: "http://127.0.0.1:8317",
      requestedModel: "kimi-k3",
      upstreamModel: "moonshot-kimi-k3",
    };
    const routedAgain = event(2, "client_to_upstream", { type: "response.create" });
    routedAgain.routing = routed.routing;
    const bundle = event(3, "client_to_upstream", "");
    bundle.routing = { action: "bundle-override" };
    const advertised = event(4, "client_to_upstream", "");
    advertised.routing = { action: "models-advertised", routeSlugs: ["kimi-k3"] };
    await writeFile(
      join(directory, "capture.ndjson"),
      `${[routed, routedAgain, bundle, advertised].map((value) => JSON.stringify(value)).join("\n")}\n`,
    );

    const telemetry = await new FileCaptureRepository(directory).routingTelemetry();

    expect(telemetry).toEqual([
      { action: "bundle-override", count: 1, lastSeenAt: bundle.timestamp },
      { action: "models-advertised", count: 1, lastSeenAt: advertised.timestamp },
      { action: "routed", routeSlug: "kimi-k3", count: 2, lastSeenAt: routedAgain.timestamp },
    ]);
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
): FullCaptureEvent {
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
