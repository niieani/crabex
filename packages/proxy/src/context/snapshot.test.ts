import { describe, expect, it } from "vite-plus/test";

import type { CaptureEvent, FullCaptureEvent } from "../recording/capture.ts";
import { buildSnapshots } from "./snapshot.ts";

describe("buildSnapshots", () => {
  it("reconstructs an inference snapshot from prewarm and linked request events", () => {
    const events: CaptureEvent[] = [
      event(1, "client_to_upstream", {
        type: "response.create",
        model: "gpt-5.6-luna",
        generate: false,
        input: [message("developer", "base instructions")],
      }),
      event(2, "upstream_to_client", {
        type: "response.completed",
        response: { id: "resp_warm", previous_response_id: null, usage: { input_tokens: 100 } },
      }),
      event(3, "client_to_upstream", {
        type: "response.create",
        model: "gpt-5.6-luna",
        previous_response_id: "resp_warm",
        input: [message("developer", "skills"), message("user", "hi")],
      }),
      event(4, "upstream_to_client", {
        type: "response.completed",
        response: {
          id: "resp_final",
          previous_response_id: "resp_warm",
          usage: { input_tokens: 180, input_tokens_details: { cached_tokens: 90 } },
        },
      }),
    ];

    const snapshots = buildSnapshots(events);

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({
      model: "gpt-5.6-luna",
      tokenization: { encoding: "o200k_base", fallback: false },
      requestSequences: [1, 3],
      usage: { inputTokens: 180, cachedTokens: 90 },
    });
    expect(snapshots[0]?.parts.map((part) => part.text)).toEqual([
      "base instructions",
      "skills",
      "hi",
    ]);
    expect(snapshots[0]?.parts.every((part) => part.digest.length === 64)).toBe(true);
  });

  it("adds model parts from the observed and effective model definitions", () => {
    const events: CaptureEvent[] = [
      event(1, "client_to_upstream", {
        type: "response.create",
        model: "gpt-5.6-luna",
        input: [message("user", "hi")],
      }),
    ];
    const original = [
      {
        slug: "gpt-5.6-luna",
        model_messages: {
          instructions_template: "You are Codex, an agent based on GPT-5. Be helpful.",
          token_budget: { guidance_message: "Use notes to checkpoint." },
        },
      },
    ];
    const effective = [
      {
        slug: "gpt-5.6-luna",
        model_messages: {
          instructions_template: "You are Codex, an agent based on GPT-5. Be terse.",
          token_budget: { guidance_message: "" },
        },
      },
    ];

    const snapshots = buildSnapshots(events, { original, effective });

    const modelParts = snapshots[0]?.parts.filter((part) => part.phase === "model");
    expect(modelParts?.map((part) => part.path)).toEqual([
      "model_messages.instructions_template",
      "model_messages.token_budget.guidance_message",
    ]);
    const instructions = modelParts?.[0];
    expect(instructions).toMatchObject({
      kind: "message",
      role: "developer",
      name: "Codex base instructions",
      identifier: "segment:codex_base",
      text: "You are Codex, an agent based on GPT-5. Be terse.",
      originalText: "You are Codex, an agent based on GPT-5. Be helpful.",
    });
    const guidance = modelParts?.[1];
    expect(guidance).toMatchObject({
      identifier: "model:model_messages.token_budget.guidance_message",
      text: "",
      originalText: "Use notes to checkpoint.",
      deleted: true,
    });
  });

  it("keeps the classified identifier when a transformation breaks the prefix", () => {
    const events: CaptureEvent[] = [
      event(1, "client_to_upstream", {
        type: "response.create",
        model: "gpt-5.6-luna",
        input: [message("user", "hi")],
      }),
    ];
    const original = [
      {
        slug: "gpt-5.6-luna",
        model_messages: {
          instructions_template: "You are Codex, an agent based on GPT-5. Be helpful.",
        },
      },
    ];
    const effective = [
      {
        slug: "gpt-5.6-luna",
        model_messages: {
          instructions_template: "You are Codex (edited), an agent based on GPT-5. Be helpful.",
        },
      },
    ];

    const snapshots = buildSnapshots(events, { original, effective });

    const part = snapshots[0]?.parts.find((item) => item.phase === "model");
    expect(part).toMatchObject({
      identifier: "segment:codex_base",
      name: "Codex base instructions",
      text: "You are Codex (edited), an agent based on GPT-5. Be helpful.",
      originalText: "You are Codex, an agent based on GPT-5. Be helpful.",
    });
  });

  it("omits model parts when the snapshot model is not in the model context", () => {
    const events: CaptureEvent[] = [
      event(1, "client_to_upstream", {
        type: "response.create",
        model: "gpt-5.6-luna",
        input: [message("user", "hi")],
      }),
    ];
    const definitions = [{ slug: "other-model", model_messages: { notes: "Some notes." } }];

    const snapshots = buildSnapshots(events, { original: definitions, effective: definitions });

    expect(snapshots[0]?.parts.every((part) => part.phase !== "model")).toBe(true);
  });

  it("carries the routing decision onto the snapshot", () => {
    const request = event(1, "client_to_upstream", {
      type: "response.create",
      model: "kimi-k3",
      input: [message("user", "hi")],
    });
    request.routing = {
      action: "routed",
      routeSlugs: ["kimi-k3"],
      upstream: "http://127.0.0.1:8317",
      requestedModel: "kimi-k3",
      upstreamModel: "moonshot-kimi-k3",
    };

    const snapshots = buildSnapshots([request]);

    expect(snapshots[0]).toMatchObject({
      model: "kimi-k3",
      routing: {
        action: "routed",
        routeSlugs: ["kimi-k3"],
        upstream: "http://127.0.0.1:8317",
        upstreamModel: "moonshot-kimi-k3",
      },
    });
  });

  it("uses metadata-only response completion events for usage correlation", () => {
    const request = event(1, "client_to_upstream", {
      type: "response.create",
      model: "gpt-5.6-luna",
      input: [message("user", "hi")],
    });
    const completed: CaptureEvent = {
      sessionId: "session-1",
      sequence: 2,
      timestamp: new Date(2000).toISOString(),
      transport: "websocket",
      direction: "upstream_to_client",
      encoding: "utf8",
      payloadMode: "metadata",
      payloadBytes: 120,
      responseSummary: {
        type: "response.completed",
        id: "resp_1",
        usage: { inputTokens: 12, cachedTokens: 4 },
      },
    };

    expect(buildSnapshots([request, completed])[0]).toMatchObject({
      usage: { inputTokens: 12, cachedTokens: 4 },
    });
  });

  it("counts snapshot text with o200k_base", () => {
    const snapshot = buildSnapshots([
      event(1, "client_to_upstream", {
        type: "response.create",
        model: "gpt-5.6-luna",
        input: [message("user", "お誕生日おめでとう")],
      }),
    ])[0];

    expect(snapshot?.tokenization).toEqual({ encoding: "o200k_base", fallback: false });
    expect(snapshot?.parts[0]?.estimatedTokens).toBe(8);
  });

  it("keeps original text beside transformed effective text", () => {
    const original = {
      type: "response.create",
      model: "gpt-5.6-luna",
      input: [message("user", "original")],
    };
    const transformed = {
      ...original,
      input: [message("user", "effective")],
    };
    const request = event(1, "client_to_upstream", original);
    request.effectivePayload = JSON.stringify(transformed);
    const snapshots = buildSnapshots([
      request,
      event(2, "upstream_to_client", {
        type: "response.completed",
        response: { id: "resp_1", usage: { input_tokens: 10 } },
      }),
    ]);

    expect(snapshots[0]?.parts[0]).toMatchObject({
      text: "effective",
      originalText: "original",
      estimatedTokens: 1,
      originalEstimatedTokens: 1,
    });
  });

  it("names classified segments and exposes Markdown subsections", () => {
    const events = [
      event(1, "client_to_upstream", {
        type: "response.create",
        model: "gpt-5.6-luna",
        input: [
          message(
            "developer",
            "<skills_instructions>\n## Skills\n### Available skills\n- imagegen: Generate.\n</skills_instructions>",
          ),
        ],
      }),
    ];

    const snapshot = buildSnapshots(events)[0];

    expect(snapshot?.parts[0]).toMatchObject({
      identifier: "segment:skills",
      name: "Skills instructions",
      sections: [
        {
          label: "Skills",
          children: [
            {
              label: "Available skills",
              children: [{ identifier: "skill:imagegen", label: "imagegen" }],
            },
          ],
        },
      ],
    });
  });

  it("exposes function description, abbreviated JSON, and MCP registry tools", () => {
    const events = [
      event(1, "client_to_upstream", {
        type: "response.create",
        model: "gpt-5.6-luna",
        client_metadata: {
          "x-codex-turn-metadata": JSON.stringify({
            code_mode_tool_names: {
              mcp__codex_apps__github_get_issue_comment_reactions: {
                name: "_get_issue_comment_reactions",
                namespace: "mcp__codex_apps__github",
              },
            },
          }),
        },
        input: [
          {
            type: "additional_tools",
            tools: [
              {
                type: "namespace",
                name: "functions",
                tools: [
                  {
                    type: "function",
                    name: "wait",
                    description: "Wait for output.\nLong detail.",
                    parameters: { type: "object" },
                  },
                ],
              },
            ],
          },
        ],
      }),
    ];

    const parts = buildSnapshots(events)[0]?.parts;

    expect(parts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          identifier: "tool:functions.wait",
          description: "Wait for output.\nLong detail.",
          json: expect.stringContaining('"description": "Wait for output.…"'),
        }),
        expect.objectContaining({
          identifier: "registry:code_mode_tool_names",
          name: "Code mode tools",
          sections: [
            expect.objectContaining({
              label: "mcp",
              children: [
                expect.objectContaining({
                  label: "codex_apps",
                  children: [
                    expect.objectContaining({
                      identifier: "tool:mcp__codex_apps__github_get_issue_comment_reactions",
                      label: "github_get_issue_comment_reactions",
                    }),
                  ],
                }),
              ],
            }),
          ],
        }),
      ]),
    );
  });

  it("keeps function description and JSON diff pairs separate", () => {
    const original = responseWithTool("Original first line.\nOriginal detail.");
    const effective = responseWithTool("Effective first line.\nEffective detail.");
    const request = event(1, "client_to_upstream", original);
    request.effectivePayload = JSON.stringify(effective);

    const tool = buildSnapshots([request])[0]?.parts.find(
      (part) => part.identifier === "tool:functions.exec",
    );

    expect(tool).toMatchObject({
      description: "Effective first line.\nEffective detail.",
      originalDescription: "Original first line.\nOriginal detail.",
      json: expect.stringContaining('"description": "Effective first line.…"'),
      originalJson: expect.stringContaining('"description": "Original first line.…"'),
    });
  });

  it("retains disabled Markdown sections in the preview model", () => {
    const original = {
      type: "response.create",
      input: [message("developer", "<plugins_instructions>\n# Keep\na\n# Remove\nb")],
    };
    const effective = {
      ...original,
      input: [message("developer", "<plugins_instructions>\n# Keep\na\n")],
    };
    const request = event(1, "client_to_upstream", original);
    request.effectivePayload = JSON.stringify(effective);

    const plugins = buildSnapshots([request])[0]?.parts[0];
    const removed = plugins?.sections?.find(
      (section) => section.identifier === "section:segment:plugins/remove",
    );

    expect(removed).toMatchObject({ deleted: true, originalText: "# Remove\nb", text: "" });
  });

  it("keeps disabled parts and sections in their original payload positions", () => {
    const original = {
      type: "response.create",
      input: [
        {
          type: "additional_tools",
          tools: [
            {
              type: "namespace",
              name: "functions",
              tools: [
                { type: "function", name: "exec", description: "Exec" },
                { type: "function", name: "wait", description: "Wait" },
              ],
            },
          ],
        },
        message("developer", "<plugins_instructions>\n# Remove first\na\n# Keep second\nb"),
      ],
    };
    const effective = {
      ...original,
      input: [
        {
          type: "additional_tools",
          tools: [
            {
              type: "namespace",
              name: "functions",
              tools: [{ type: "function", name: "wait", description: "Wait" }],
            },
          ],
        },
        message("developer", "<plugins_instructions>\n# Keep second\nb"),
      ],
    };
    const request = event(1, "client_to_upstream", original);
    request.effectivePayload = JSON.stringify(effective);

    const parts = buildSnapshots([request])[0]!.parts;

    expect(parts.map((part) => part.identifier)).toEqual([
      "tool:functions.exec",
      "tool:functions.wait",
      "segment:plugins",
    ]);
    expect(parts[0]).toMatchObject({ deleted: true });
    expect(parts[2]!.sections?.map((section) => section.identifier)).toEqual([
      "section:segment:plugins/remove-first",
      "section:segment:plugins/keep-second",
    ]);
    expect(parts[2]!.sections?.[0]).toMatchObject({ deleted: true });
  });

  it("aggregates duplicate code mode tool registries across linked requests", () => {
    const registry = {
      mcp__codex_apps__sites_list_sites: { name: "sites_list_sites" },
      apply_patch: { name: "apply_patch" },
    };
    const events: CaptureEvent[] = [
      event(1, "client_to_upstream", responseWithRegistry(registry, false)),
      event(2, "upstream_to_client", {
        type: "response.completed",
        response: { id: "resp_warm", usage: { input_tokens: 10 } },
      }),
      event(3, "client_to_upstream", {
        ...responseWithRegistry(registry, true),
        previous_response_id: "resp_warm",
      }),
    ];

    const registries = buildSnapshots(events)[0]?.parts.filter(
      (part) => part.identifier === "registry:code_mode_tool_names",
    );

    expect(registries).toHaveLength(1);
    expect(JSON.stringify(registries?.[0]?.sections)).toContain("sites_list_sites");
  });
});

function responseWithTool(description: string) {
  return {
    type: "response.create",
    input: [
      {
        type: "additional_tools",
        tools: [
          {
            type: "namespace",
            name: "functions",
            tools: [{ type: "function", name: "exec", description }],
          },
        ],
      },
    ],
  };
}

function responseWithRegistry(registry: Record<string, unknown>, generate: boolean) {
  return {
    type: "response.create",
    generate,
    client_metadata: {
      "x-codex-turn-metadata": JSON.stringify({ code_mode_tool_names: registry }),
    },
    input: [],
  };
}

function event(
  sequence: number,
  direction: CaptureEvent["direction"],
  payload: unknown,
): FullCaptureEvent {
  return {
    sessionId: "session-1",
    sequence,
    timestamp: new Date(sequence * 1000).toISOString(),
    transport: "websocket",
    direction,
    encoding: "utf8",
    payload: JSON.stringify(payload),
    harness: { kind: "tui", version: "0.146.0" },
    project: "fixture",
  };
}

function message(role: string, text: string): unknown {
  return { type: "message", role, content: [{ type: "input_text", text }] };
}
