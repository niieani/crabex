import { describe, expect, it } from "vite-plus/test";

import type { CaptureEvent } from "../recording/capture.ts";
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
          identifier: "tool:mcp__codex_apps__github_get_issue_comment_reactions",
          name: "mcp__codex_apps__github_get_issue_comment_reactions",
        }),
      ]),
    );
  });
});

function event(
  sequence: number,
  direction: CaptureEvent["direction"],
  payload: unknown,
): CaptureEvent {
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
