import { describe, expect, it } from "vite-plus/test";

import { transformResponseCreate, TransformationError } from "./transform.ts";
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
            { type: "function", name: "wait", description: "Wait for output", parameters: {} },
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
        cardinality: { min: 1, max: 2 },
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
        cardinality: { min: 1, max: 1 },
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
    expect(result.applied).toEqual([
      { transformationId: "remove-markers", matchCount: 1 },
      { transformationId: "inject-smoke", matchCount: 1 },
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
          cardinality: { min: 1, max: 1 },
        }),
      ],
      { harness: { kind: "tui" } },
    );

    expect(nestedToolNames(result.payload)).toEqual(["exec"]);
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

    expect(result.applied).toEqual([]);
    expect(result.payload).toEqual(payload);
  });

  it("fails explicitly when match cardinality is unexpected", () => {
    expect(() =>
      transformResponseCreate(
        payload,
        [
          rule({
            id: "required",
            operation: { type: "replace_all", find: "not present", replacement: "x" },
            cardinality: { min: 1, max: 1 },
          }),
        ],
        { harness: { kind: "tui" } },
      ),
    ).toThrow(new TransformationError("required", 0, { min: 1, max: 1 }));
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
    cardinality: { min: 0 },
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
