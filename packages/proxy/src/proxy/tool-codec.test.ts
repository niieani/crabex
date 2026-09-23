import { describe, expect, it } from "vite-plus/test";
import { createToolCodec, normalizeToolCallId } from "./tool-codec.ts";

describe("tool codec", () => {
  it("flattens namespaces, wraps custom and union tools, and restores Codex calls", () => {
    const codec = createToolCodec(
      [
        {
          type: "namespace",
          name: "desktop",
          tools: [
            {
              type: "function",
              name: "update",
              parameters: {
                oneOf: [{ $ref: "#/$defs/change" }],
                $defs: { change: { type: "object", properties: { value: { type: "string" } } } },
              },
            },
          ],
        },
        { type: "custom", name: "apply_patch", format: { type: "text" } },
      ],
      { namespace: "flatten", custom: "wrap", union: "wrap" },
    );

    expect(codec.declarations).toHaveLength(2);
    const update = codec.tools[0]!;
    expect(update.wire).toMatch(/^tool_[0-9a-f]{48}$/);
    expect(update.namespace).toBe("desktop");
    expect(update.wrapped).toBe(true);
    expect(update.parameters).toMatchObject({
      properties: {
        arguments: { oneOf: [{ $ref: "#/properties/arguments/$defs/change" }] },
      },
    });
    expect(codec.tools[1]!.parameters).toMatchObject({
      properties: {
        input: {
          description: "Raw patch starting with *** Begin Patch and ending with *** End Patch.",
        },
      },
    });
    expect(codec.declarations[1]).not.toHaveProperty("format");
    expect(
      codec.encode({
        type: "function_call",
        name: "update",
        namespace: "desktop",
        call_id: "call-1",
        arguments: '{"value":"ok"}',
      }),
    ).toEqual({ name: update.wire, callId: "call-1", input: { arguments: { value: "ok" } } });
    expect(
      codec.decode({ name: update.wire, callId: "call-2", input: { arguments: { value: "ok" } } }),
    ).toEqual({
      type: "function_call",
      name: "update",
      namespace: "desktop",
      call_id: "call-2",
      arguments: '{"value":"ok"}',
    });
    expect(
      codec.decode({ name: "apply_patch", callId: "call-3", input: { input: "patch" } }),
    ).toEqual({
      type: "custom_tool_call",
      name: "apply_patch",
      call_id: "call-3",
      input: "patch",
    });
    expect(codec.decode({ name: "apply_patch", callId: "call-3" })).toMatchObject({
      type: "custom_tool_call",
      input: "",
    });
    expect(() => codec.decode({ name: "apply_patch", callId: "call-3", input: "patch" })).toThrow(
      "Custom tool requires a string input",
    );
  });

  it("preserves native namespaces and unions while wrapping only custom tools", () => {
    const native = createToolCodec(
      [
        {
          type: "namespace",
          name: "mcp",
          tools: [{ type: "function", name: "read", parameters: { anyOf: [{ type: "object" }] } }],
        },
        { type: "custom", name: "exec", description: "Execute JavaScript" },
        { type: "web_search" },
      ],
      { namespace: "preserve", custom: "wrap", union: "preserve", other: "pass" },
    );

    expect(native.declarations).toMatchObject([
      {
        type: "namespace",
        name: "mcp",
        tools: [{ type: "function", name: "read", parameters: { anyOf: [{ type: "object" }] } }],
      },
      { type: "function", name: "exec", parameters: { properties: { input: { type: "string" } } } },
      { type: "web_search" },
    ]);
    expect(native.tools[0]).toMatchObject({
      name: "read",
      namespace: "mcp",
      wire: "read",
      wireNamespace: "mcp",
      wrapped: false,
    });
    expect(
      native.encode({
        type: "function_call",
        name: "read",
        namespace: "mcp",
        call_id: "call-1",
        arguments: "{}",
      }),
    ).toEqual({ name: "read", namespace: "mcp", callId: "call-1", input: {} });
    expect(native.decode({ name: "read", namespace: "mcp", callId: "call-2", input: {} })).toEqual({
      type: "function_call",
      name: "read",
      namespace: "mcp",
      call_id: "call-2",
      arguments: "{}",
    });
  });

  it("can keep custom input native when the provider supports it", () => {
    const native = createToolCodec([{ type: "custom", name: "exec", format: { type: "text" } }], {
      namespace: "preserve",
      custom: "preserve",
      union: "preserve",
    });
    expect(native.declarations).toEqual([
      { type: "custom", name: "exec", format: { type: "text" } },
    ]);
    expect(
      native.encode({ type: "custom_tool_call", name: "exec", call_id: "1", input: "run" }),
    ).toEqual({
      name: "exec",
      callId: "1",
      input: "run",
    });
    expect(native.decode({ name: "exec", callId: "2", input: "run" })).toEqual({
      type: "custom_tool_call",
      name: "exec",
      call_id: "2",
      input: "run",
    });
  });

  it("treats Codex's functions namespace as the default when flattening", () => {
    const codec = createToolCodec(
      [
        {
          type: "namespace",
          name: "functions",
          tools: [{ type: "function", name: "read", parameters: { type: "object" } }],
        },
      ],
      { namespace: "flatten", custom: "wrap", union: "wrap" },
    );
    expect(codec.tools[0]).toMatchObject({ wire: "read" });
    expect(
      codec.encode({
        type: "function_call",
        name: "read",
        namespace: "functions",
        call_id: "1",
        arguments: "{}",
      }),
    ).toEqual({ name: "read", callId: "1", input: {} });
    expect(codec.decode({ name: "read", callId: "2", input: {} })).toEqual({
      type: "function_call",
      name: "read",
      call_id: "2",
      arguments: "{}",
    });
  });

  it("normalizes unsafe call IDs and rejects ambiguous or malformed declarations", () => {
    expect(normalizeToolCallId("abc_123")).toBe("abc_123");
    expect(normalizeToolCallId("call.with.dots")).toMatch(/^call_[0-9a-f]{48}$/);
    expect(() => normalizeToolCallId("")).toThrow("missing its call_id");
    expect(() =>
      createToolCodec(
        [
          { type: "function", name: "same", parameters: {} },
          { type: "function", name: "same", parameters: {} },
        ],
        { namespace: "flatten", custom: "wrap", union: "wrap" },
      ),
    ).toThrow("Ambiguous tool names");
    expect(() =>
      createToolCodec([{ type: "web_search" }], {
        namespace: "flatten",
        custom: "wrap",
        union: "wrap",
      }),
    ).toThrow("Unsupported tool type: web_search");
    const replay = createToolCodec([], { namespace: "flatten", custom: "wrap", union: "wrap" });
    expect(
      replay.encode({
        type: "function_call",
        name: "read",
        namespace: "mcp",
        call_id: "call.with.dots",
        arguments: "{}",
      }),
    ).toMatchObject({
      name: "tool_3ba362b9fd7924abb40965d862798641102accc991b102e5",
      callId: "call_59f1e3df0720f50c38092daf7c008a29574465cdd16fb145",
      input: {},
    });
    expect(() =>
      replay.encode({
        type: "function_call",
        name: "read",
        call_id: "1",
        arguments: 42,
      }),
    ).toThrow("Invalid JSON arguments for read");
  });
});
