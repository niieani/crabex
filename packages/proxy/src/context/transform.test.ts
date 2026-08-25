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

  it("replaces a decoded multiline string at an exact structured tool JSON path", () => {
    const multilinePayload = structuredClone(payload);
    waitTool(multilinePayload).parameters.properties.reason.description = "Old schema\nguidance";
    const result = transformResponseCreate(
      multilinePayload,
      [
        rule({
          scope: { tools: ["tool:functions.wait"] },
          target: {
            field: "json_value",
            jsonPath: ["parameters", "properties", "reason", "description"],
          },
          operation: {
            type: "replace_all",
            find: "Old schema\nguidance",
            replacement: "Short guidance",
          },
        }),
      ],
      { harness: { kind: "tui" } },
    );

    expect(result.executions[0]).toMatchObject({ status: "hit", matchCount: 1 });
    expect(waitTool(result.payload).parameters.properties.reason.description).toBe(
      "Short guidance",
    );
    expect(waitTool(multilinePayload).parameters.properties.reason.description).toBe(
      "Old schema\nguidance",
    );
  });

  it("deletes an exact property or array element by structured tool JSON path", () => {
    const structured = structuredToolPayload();
    const result = transformResponseCreate(
      structured,
      [
        rule({
          scope: { tools: ["tool:functions.call"] },
          target: { field: "json_value", jsonPath: ["parameters", "required", 0] },
          operation: { type: "delete_part" },
        }),
        rule({
          scope: { tools: ["tool:functions.call"] },
          target: {
            field: "json_value",
            jsonPath: ["parameters", "properties", "optional"],
          },
          operation: { type: "delete_part" },
        }),
      ],
      { harness: { kind: "tui" } },
    );

    const tool = callTool(result.payload);
    expect(tool.parameters.required).toEqual(["optional"]);
    expect(tool.parameters.properties).not.toHaveProperty("optional");
    expect(result.executions).toEqual([
      { transformationId: "rule", status: "hit", matchCount: 1 },
      { transformationId: "rule", status: "hit", matchCount: 1 },
    ]);
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

  it("limits a text replacement to its stable Codex segment scope", () => {
    const result = transformResponseCreate(
      {
        type: "response.create",
        input: [
          message("developer", "<plugins_instructions>\nshared text"),
          message("developer", "<skills_instructions>\nshared text"),
        ],
      },
      [
        rule({
          scope: { segments: ["segment:plugins"] },
          operation: { type: "replace_all", find: "shared", replacement: "scoped" },
        }),
      ],
      { harness: { kind: "desktop" } },
    );

    expect(textAt(result.payload, 0)).toContain("scoped text");
    expect(textAt(result.payload, 1)).toContain("shared text");
    expect(result.executions[0]).toMatchObject({ status: "hit", matchCount: 1 });
  });

  it("limits a text replacement to one structured tool definition", () => {
    const result = transformResponseCreate(
      {
        type: "response.create",
        input: [
          {
            type: "additional_tools",
            tools: [
              {
                type: "namespace",
                name: "functions",
                tools: [
                  { type: "function", name: "exec", description: "Shared guidance" },
                  { type: "function", name: "wait", description: "Shared guidance" },
                ],
              },
            ],
          },
        ],
      },
      [
        rule({
          scope: { tools: ["tool:functions.exec"] },
          target: { field: "tool_description" },
          operation: { type: "replace_all", find: "Shared", replacement: "Scoped" },
        }),
      ],
      { harness: { kind: "tui" } },
    );

    const serialized = JSON.stringify(result.payload);
    expect(serialized).toContain('"name":"exec","description":"Scoped guidance"');
    expect(serialized).toContain('"name":"wait","description":"Shared guidance"');
    expect(result.executions[0]).toMatchObject({ status: "hit", matchCount: 1 });
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

  it("deletes a classified message segment by stable identifier", () => {
    const result = transformResponseCreate(
      {
        type: "response.create",
        input: [
          {
            type: "message",
            role: "developer",
            content: [{ type: "input_text", text: "<apps_instructions>\napps" }],
          },
          { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
        ],
      },
      [
        rule({
          target: { field: "message_text", identifier: "segment:apps" },
          operation: { type: "delete_part" },
        }),
      ],
      { harness: { kind: "desktop" } },
    );

    expect(result.executions[0]).toMatchObject({ status: "hit", matchCount: 1 });
    expect(result.payload.input).toHaveLength(1);
  });

  it("deletes one classified Markdown subsection", () => {
    const result = transformResponseCreate(
      {
        type: "response.create",
        input: [
          {
            type: "message",
            role: "developer",
            content: [
              {
                type: "input_text",
                text: "You are Codex, agent.\n# Keep\na\n# Remove\nb\n# Also keep\nc",
              },
            ],
          },
        ],
      },
      [
        rule({
          target: {
            field: "message_text",
            identifier: "section:segment:codex_base/remove",
          },
          operation: { type: "delete_part" },
        }),
      ],
      { harness: { kind: "desktop" } },
    );

    expect(JSON.stringify(result.payload)).not.toContain("# Remove");
    expect(JSON.stringify(result.payload)).toContain("# Also keep");
  });

  it("deletes one complete generated exec tool block despite headings in its description", () => {
    const description = [
      "### `request_plugin_install`",
      "# Suggest a recommended plugin installation",
      "Details.",
      "",
      "exec tool declaration:",
      "```ts",
      "declare const tools: { request_plugin_install(args: {}): Promise<unknown>; };",
      "```",
      "",
      "### `update_plan`",
      "Updates the plan.",
      "",
      "exec tool declaration:",
      "```ts",
      "declare const tools: { update_plan(args: {}): Promise<unknown>; };",
      "```",
    ].join("\n");
    const result = transformResponseCreate(
      {
        type: "response.create",
        input: [
          {
            type: "additional_tools",
            tools: [
              {
                type: "namespace",
                name: "functions",
                tools: [{ type: "custom", name: "exec", description }],
              },
            ],
          },
        ],
      },
      [
        rule({
          target: { field: "tool_description", identifier: "tool:request_plugin_install" },
          operation: { type: "delete_part" },
        }),
      ],
      { harness: { kind: "desktop" } },
    );

    const serialized = JSON.stringify(result.payload);
    expect(serialized).not.toContain("request_plugin_install");
    expect(serialized).not.toContain("Suggest a recommended plugin installation");
    expect(serialized).toContain("### `update_plan`");
    expect(serialized).toContain("declare const tools: { update_plan");
  });

  it("deletes an MCP tool from structured client metadata", () => {
    const mcpName = "mcp__codex_apps__github_get_issue_comment_reactions";
    const metadata = {
      code_mode_tool_names: {
        [mcpName]: { name: "_get_issue_comment_reactions", namespace: "mcp__codex_apps__github" },
        apply_patch: { name: "apply_patch", namespace: null },
      },
    };
    const result = transformResponseCreate(
      {
        type: "response.create",
        client_metadata: { "x-codex-turn-metadata": JSON.stringify(metadata) },
        input: [],
      },
      [
        rule({
          target: { field: "tool", identifier: `tool:${mcpName}` },
          operation: { type: "delete_part" },
        }),
      ],
      { harness: { kind: "desktop" } },
    );

    const encoded = (result.payload.client_metadata as Record<string, string>)[
      "x-codex-turn-metadata"
    ];
    expect(JSON.parse(encoded).code_mode_tool_names).toEqual({
      apply_patch: { name: "apply_patch", namespace: null },
    });
  });

  it("applies a JSON value transformation inside code-mode tool metadata", () => {
    const mcpName = "mcp__codex_apps__github_get_issue_comment_reactions";
    const metadata = {
      code_mode_tool_names: {
        [mcpName]: { name: "_get_issue_comment_reactions", namespace: "mcp__codex_apps__github" },
      },
    };
    const result = transformResponseCreate(
      {
        type: "response.create",
        client_metadata: { "x-codex-turn-metadata": JSON.stringify(metadata) },
        input: [],
      },
      [
        rule({
          target: { field: "json_value", jsonPath: [mcpName, "name"] },
          operation: { type: "replace", find: "issue_comment", replacement: "repo" },
        }),
      ],
      { harness: { kind: "desktop" } },
    );

    const encoded = (result.payload.client_metadata as Record<string, string>)[
      "x-codex-turn-metadata"
    ];
    expect(JSON.parse(encoded).code_mode_tool_names[mcpName]).toEqual({
      name: "_get_repo_reactions",
      namespace: "mcp__codex_apps__github",
    });
    expect(result.executions[0]).toMatchObject({ status: "hit", matchCount: 1 });
  });

  it("deletes a complete code-mode tool group by namespace prefix", () => {
    const metadata = {
      code_mode_tool_names: {
        mcp__codex_apps__sites_list_sites: { name: "sites_list_sites" },
        mcp__codex_apps__github_get_repo: { name: "github_get_repo" },
        mcp__node_repl__js: { name: "js" },
        apply_patch: { name: "apply_patch" },
      },
    };
    const result = transformResponseCreate(
      {
        type: "response.create",
        client_metadata: { "x-codex-turn-metadata": JSON.stringify(metadata) },
        input: [],
      },
      [
        rule({
          target: { field: "tool", identifier: "registry-group:mcp__codex_apps" },
          operation: { type: "delete_part" },
        }),
      ],
      { harness: { kind: "desktop" } },
    );

    const encoded = (result.payload.client_metadata as Record<string, string>)[
      "x-codex-turn-metadata"
    ];
    expect(Object.keys(JSON.parse(encoded).code_mode_tool_names)).toEqual([
      "mcp__node_repl__js",
      "apply_patch",
    ]);
    expect(result.executions[0]).toMatchObject({ status: "hit", matchCount: 2 });
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

function waitTool(value: unknown) {
  const tool = (
    value as {
      input: Array<{
        tools: Array<{
          tools: Array<{
            name: string;
            parameters: {
              properties: { reason: { description: string } };
            };
          }>;
        }>;
      }>;
    }
  ).input[0]!.tools[0]!.tools.find((candidate) => candidate.name === "wait");
  if (tool === undefined) throw new Error("wait tool is missing");
  return tool;
}

function structuredToolPayload() {
  return {
    type: "response.create",
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
                name: "call",
                parameters: {
                  type: "object",
                  properties: {
                    required: { type: "string" },
                    optional: { type: "string" },
                  },
                  required: ["required", "optional"],
                },
              },
            ],
          },
        ],
      },
    ],
  };
}

function callTool(value: unknown) {
  return (
    value as {
      input: Array<{
        tools: Array<{
          tools: Array<{
            parameters: {
              properties: Record<string, unknown>;
              required: string[];
            };
          }>;
        }>;
      }>;
    }
  ).input[0]!.tools[0]!.tools[0]!;
}

function message(role: string, text: string) {
  return { type: "message", role, content: [{ type: "input_text", text }] };
}
