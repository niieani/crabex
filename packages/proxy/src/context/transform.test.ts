import { describe, expect, it } from "vite-plus/test";

import { transformResponseCreate } from "./transform.ts";
import type { Transformation } from "./transformation.ts";

const payload = {
  type: "response.create",
  model: "gpt-5.6-luna",
  input: [
    {
      type: "additional_tools",
      role: "developer",
      tools: [
        {
          type: "namespace",
          name: "functions",
          tools: [
            { type: "custom", name: "exec", description: "Execute commands safely" },
            {
              type: "function",
              name: "wait",
              description: "Wait for output",
              parameters: {
                type: "object",
                properties: { reason: { type: "string", description: "Old schema guidance" } },
              },
            },
          ],
        },
      ],
    },
    {
      type: "message",
      role: "developer",
      content: [{ type: "input_text", text: "Keep this. REMOVE ME. REMOVE ME." }],
    },
    {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "Reply with exactly: audit-ok" }],
    },
  ],
};

describe("transformResponseCreate", () => {
  it("applies ordered literal and RE2 replacements without mutating the original", () => {
    const transformations: Transformation[] = [
      rule({
        id: "remove-markers",
        operation: { type: "replace_all", find: "REMOVE ME. ", replacement: "" },
      }),
      rule({
        id: "inject-smoke",
        operation: {
          type: "regex",
          pattern: "Reply with exactly: [a-z-]+",
          replacement: "Reply with exactly: transformed-ok",
          flags: "",
          replaceAll: false,
        },
      }),
    ];

    const result = transformResponseCreate(payload, transformations, {
      harness: { kind: "tui", version: "0.146.0" },
      project: "agent-context-trimmer",
    });

    expect(result.payload).not.toBe(payload);
    expect(textAt(result.payload, 1)).toBe("Keep this. REMOVE ME.");
    expect(textAt(result.payload, 2)).toBe("Reply with exactly: transformed-ok");
    expect(textAt(payload, 1)).toBe("Keep this. REMOVE ME. REMOVE ME.");
    expect(result.executions).toEqual([
      { transformationId: "remove-markers", status: "hit", matchCount: 1 },
      { transformationId: "inject-smoke", status: "hit", matchCount: 1 },
    ]);
  });

  it("deletes a structurally named tool without parsing its description", () => {
    const result = transformResponseCreate(
      payload,
      [
        rule({
          id: "disable-wait",
          target: { field: "tool", toolName: "wait" },
          operation: { type: "delete_part" },
        }),
      ],
      { harness: { kind: "tui" } },
    );

    expect(nestedToolNames(result.payload)).toEqual(["exec"]);
  });

  it("mechanically replaces arbitrary string leaves inside a structured tool", () => {
    const result = transformResponseCreate(
      payload,
      [
        rule({
          id: "schema-copy",
          target: { field: "all_text" },
          operation: {
            type: "replace_all",
            find: "Old schema guidance",
            replacement: "Short guidance",
          },
        }),
      ],
      { harness: { kind: "tui" } },
    );

    expect(JSON.stringify(result.payload)).toContain("Short guidance");
    expect(JSON.stringify(result.payload)).not.toContain("Old schema guidance");
  });

  it("skips transformations outside their harness, model, or project scope", () => {
    const result = transformResponseCreate(
      payload,
      [
        rule({
          id: "desktop-only",
          scope: { harnesses: ["desktop"] },
          operation: { type: "replace_all", find: "Keep", replacement: "Drop" },
        }),
      ],
      { harness: { kind: "tui" } },
    );

    expect(result.executions).toEqual([]);
    expect(result.payload).toEqual(payload);
  });

  it("passes through a request and records a miss when a rule does not match", () => {
    const result = transformResponseCreate(
      payload,
      [
        rule({
          id: "missing",
          operation: { type: "replace_all", find: "not present", replacement: "x" },
        }),
      ],
      { harness: { kind: "tui" } },
    );

    expect(result.payload).toEqual(payload);
    expect(result.executions).toEqual([
      { transformationId: "missing", status: "miss", matchCount: 0 },
    ]);
  });

  it("passes through a request and records an error for an invalid rule", () => {
    const result = transformResponseCreate(
      payload,
      [
        rule({
          id: "invalid-regexp",
          operation: {
            type: "regex",
            pattern: "(",
            replacement: "x",
            flags: "",
            replaceAll: true,
          },
        }),
      ],
      { harness: { kind: "tui" } },
    );

    expect(result.payload).toEqual(payload);
    expect(result.executions).toEqual([
      expect.objectContaining({
        transformationId: "invalid-regexp",
        status: "error",
        matchCount: 0,
      }),
    ]);
  });
});

function rule(overrides: Partial<Transformation>): Transformation {
  return {
    id: "rule",
    name: "Rule",
    enabled: true,
    scope: {},
    target: { field: "message_text" },
    operation: { type: "replace_all", find: "x", replacement: "y" },
    ...overrides,
  };
}

function textAt(value: unknown, inputIndex: number): string {
  const payload = value as { input?: Array<{ content?: Array<{ text?: unknown }> }> };
  const text = payload.input?.[inputIndex]?.content?.[0]?.text;
  if (typeof text !== "string") throw new Error("fixture text is missing");
  return text;
}

function nestedToolNames(value: unknown): string[] {
  const payload = value as {
    input?: Array<{ tools?: Array<{ tools?: Array<{ name?: unknown }> }> }>;
  };
  const tools = payload.input?.[0]?.tools?.[0]?.tools;
  if (tools === undefined) throw new Error("fixture tools are missing");
  return tools.map((tool) => {
    if (typeof tool.name !== "string") throw new Error("fixture tool name is missing");
    return tool.name;
  });
}
