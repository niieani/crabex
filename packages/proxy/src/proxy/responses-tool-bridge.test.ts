import { describe, expect, it } from "vite-plus/test";
import { modelRouteFromConfig } from "../routing/model-routes.ts";
import { createResponsesToolBridge } from "./responses-tool-bridge.ts";

const route = modelRouteFromConfig({
  authorization_env: "TEST_KEY",
  transport: "http",
  tool_policy: { custom: "translate" },
  model: {
    slug: "flash-test",
    display_name: "Flash test",
    description: "Test Responses bridge",
    priority: 1,
    template_slug: "gpt-6-astra",
  },
  upstream: "https://gateway.example/v1",
});

describe("Responses tool discovery bridge", () => {
  it("marks only deliberately plaintext collaboration calls and strips their outbound annotation", () => {
    const declaration = {
      type: "namespace",
      name: "collaboration",
      tools: [
        {
          type: "function",
          name: "spawn_agent",
          parameters: {
            type: "object",
            properties: { message: { type: "string", encrypted: true } },
          },
        },
        {
          type: "function",
          name: "wait_agent",
          parameters: { type: "object", properties: { timeout_ms: { type: "integer" } } },
        },
      ],
    };
    const bridge = createResponsesToolBridge(route, [declaration])!;
    const outbound = bridge.request({ tools: [declaration] });
    expect(
      (outbound.tools as (typeof declaration)[])[0]?.tools[0]?.parameters.properties.message,
    ).toEqual({ type: "string" });
    expect(declaration.tools[0]?.parameters.properties.message).toEqual({
      type: "string",
      encrypted: true,
    });
    const call = {
      type: "function_call",
      id: "fc_spawn",
      call_id: "call_spawn",
      namespace: "collaboration",
      name: "spawn_agent",
      arguments: '{"message":"Read this task"}',
    };
    const added = bridge.event(
      JSON.stringify({ type: "response.output_item.added", output_index: 0, item: call }),
    );
    expect(JSON.parse(added[0]!).item.encrypted_function_args).toEqual([]);
    const done = bridge.event(
      JSON.stringify({ type: "response.output_item.done", output_index: 0, item: call }),
    );
    expect(JSON.parse(done[0]!).item.encrypted_function_args).toEqual([]);
    const completed = bridge.event(
      JSON.stringify({ type: "response.completed", response: { output: [call] } }),
    );
    expect(JSON.parse(completed[0]!).response.output[0].encrypted_function_args).toEqual([]);
    expect(bridge.response({ output: [call] })).toMatchObject({
      output: [{ encrypted_function_args: [] }],
    });
    const wait = bridge.event(
      JSON.stringify({
        type: "response.output_item.done",
        item: { ...call, name: "wait_agent" },
      }),
    );
    expect(JSON.parse(wait[0]!).item).not.toHaveProperty("encrypted_function_args");
    const upstreamEncrypted = bridge.event(
      JSON.stringify({
        type: "response.output_item.done",
        item: { ...call, encrypted_function_args: ["ciphertext"] },
      }),
    );
    expect(JSON.parse(upstreamEncrypted[0]!).item.encrypted_function_args).toEqual(["ciphertext"]);
  });

  it("preserves upstream encrypted arguments on a pass route with unrelated search translation", () => {
    const passRoute = modelRouteFromConfig({
      authorization_env: "TEST_KEY",
      transport: "http",
      tool_policy: { tool_search: "translate" },
      model: {
        slug: "pass-test",
        display_name: "Pass test",
        description: "Test Responses bridge",
        priority: 1,
        template_slug: "gpt-6-astra",
      },
      upstream: "https://gateway.example/v1",
    });
    const declaration = {
      type: "namespace",
      name: "collaboration",
      tools: [
        {
          type: "function",
          name: "spawn_agent",
          parameters: {
            type: "object",
            properties: { message: { type: "string", encrypted: true } },
          },
        },
      ],
    };
    const bridge = createResponsesToolBridge(passRoute, [declaration])!;
    expect(bridge.request({ tools: [declaration] }).tools).toEqual([declaration]);
    const call = {
      type: "function_call",
      name: "spawn_agent",
      namespace: "collaboration",
      call_id: "call_spawn",
      arguments: '{"message":"ciphertext"}',
      encrypted_function_args: ["ciphertext"],
    };
    for (const type of ["response.output_item.added", "response.output_item.done"])
      expect(JSON.parse(bridge.event(JSON.stringify({ type, item: call }))[0]!).item).toEqual(call);
    expect(bridge.response({ output: [call] })).toEqual({ output: [call] });
  });
  const searchRoute = modelRouteFromConfig({
    authorization_env: "TEST_KEY",
    transport: "http",
    tool_policy: { custom: "translate", tool_search: "translate" },
    model: {
      slug: "discovery-test",
      display_name: "Discovery test",
      description: "Test discovery bridge",
      priority: 1,
      template_slug: "gpt-6-astra",
    },
    upstream: "https://gateway.example/v1",
  });
  const search = {
    type: "tool_search",
    execution: "client",
    description: "Find deferred tools",
    parameters: { type: "object", properties: { query: { type: "string" } } },
  };
  const discovered = {
    type: "namespace",
    name: "inventory",
    tools: [{ type: "function", name: "lookup_item", parameters: { type: "object" } }],
  };
  const call = {
    type: "function_call",
    id: "fc_search",
    call_id: "search_1",
    name: "tool_search",
    arguments: '{"query":"inventory lookup"}',
    status: "completed",
  };

  it("converts search history and its result while injecting discovered declarations", () => {
    const bridge = createResponsesToolBridge(searchRoute, [search, discovered])!;
    const output = {
      type: "tool_search_output",
      call_id: "search_1",
      status: "completed",
      execution: "client",
      tools: [discovered],
    };
    const result = bridge.request({
      tools: [search, discovered],
      tool_choice: { type: "tool_search" },
      parallel_tool_calls: false,
      input: [
        {
          type: "tool_search_call",
          call_id: "search_1",
          execution: "client",
          arguments: { query: "inventory lookup" },
        },
        output,
      ],
    });
    expect(result.tools).toMatchObject([
      { type: "function", name: "tool_search", description: search.description },
      discovered,
    ]);
    expect(result.tool_choice).toEqual({ type: "function", name: "tool_search" });
    expect(result.parallel_tool_calls).toBe(false);
    expect(result.input).toMatchObject([
      {
        type: "function_call",
        call_id: "search_1",
        name: "tool_search",
        arguments: call.arguments,
      },
      {
        type: "function_call_output",
        call_id: "search_1",
        output: expect.stringContaining("inventory.lookup_item"),
      },
    ]);
  });

  it("buffers search arguments and restores JSON-valued calls in every response shape", () => {
    const bridge = createResponsesToolBridge(searchRoute, [search, discovered])!;
    const added = bridge.event(
      JSON.stringify({
        type: "response.output_item.added",
        output_index: 0,
        item: { ...call, arguments: "", status: "in_progress" },
      }),
    );
    expect(JSON.parse(added[0]!).item).toMatchObject({
      type: "tool_search_call",
      call_id: "search_1",
      execution: "client",
      arguments: {},
    });
    expect(
      bridge.event(
        JSON.stringify({
          type: "response.function_call_arguments.delta",
          item_id: "fc_search",
          delta: '{"query":"inventory lookup"}',
        }),
      ),
    ).toEqual([]);
    expect(
      bridge.event(
        JSON.stringify({
          type: "response.function_call_arguments.done",
          item_id: "fc_search",
          arguments: call.arguments,
        }),
      ),
    ).toEqual([]);
    const done = bridge.event(JSON.stringify({ type: "response.output_item.done", item: call }));
    expect(done.map((value) => JSON.parse(value).type)).toEqual(["response.output_item.done"]);
    expect(JSON.parse(done[0]!).item).toMatchObject({
      type: "tool_search_call",
      call_id: "search_1",
      execution: "client",
      arguments: { query: "inventory lookup" },
    });
    const completed = bridge.event(
      JSON.stringify({
        type: "response.completed",
        response: {
          id: "resp_1",
          output: [
            call,
            {
              type: "function_call",
              id: "fc_lookup",
              call_id: "lookup_1",
              namespace: "inventory",
              name: "lookup_item",
              arguments: '{"sku":"A"}',
            },
          ],
        },
      }),
    );
    expect(JSON.parse(completed[0]!).response.output).toMatchObject([
      { type: "tool_search_call", arguments: { query: "inventory lookup" } },
      { type: "function_call", namespace: "inventory", name: "lookup_item" },
    ]);
  });
});
const tools = [
  { type: "custom", name: "apply_patch", format: { type: "text" } },
  {
    type: "namespace",
    name: "mcp",
    tools: [{ type: "function", name: "read", parameters: { oneOf: [{ type: "object" }] } }],
  },
];
const patch = "*** Begin Patch\n*** Add File: note.txt\n+ok\n*** End Patch";
const argumentJson = JSON.stringify({ input: patch });
const wireCall = {
  type: "function_call",
  id: "fc_1",
  call_id: "call_1",
  name: "apply_patch",
  arguments: argumentJson,
  status: "completed",
};

describe("Responses custom tool bridge", () => {
  it("preserves native web search calls, answer URLs, and provider source output", () => {
    const bridge = createResponsesToolBridge(route, [tools[0], { type: "web_search" }])!;
    const search = {
      type: "web_search_call",
      id: "ws_1",
      status: "completed",
      action: { type: "search", query: "NASA Mars facts" },
    };
    const source = {
      type: "tool_output",
      tool_call_id: "provider_1",
      output: '{"results":[{"url":"https://science.nasa.gov/mars/facts/","title":"Mars: Facts"}]}',
    };
    const message = {
      type: "message",
      id: "msg_1",
      role: "assistant",
      content: [
        {
          type: "output_text",
          text: "https://science.nasa.gov/mars/facts/",
          annotations: [],
        },
      ],
    };
    const done = { type: "response.output_item.done", item: search };
    expect(JSON.parse(bridge.event(JSON.stringify(done))[0]!)).toMatchObject(done);
    const completed = {
      type: "response.completed",
      response: { id: "resp_1", output: [search, source, message] },
    };
    expect(JSON.parse(bridge.event(JSON.stringify(completed))[0]!).response.output).toEqual([
      search,
      source,
      message,
    ]);
  });

  it("wraps only custom declarations and translates choices and replayed calls", () => {
    const bridge = createResponsesToolBridge(route, tools)!;
    const image = { type: "input_image", image_url: "data:image/png;base64,aGVsbG8=" };
    const request = bridge.request({
      tools,
      tool_choice: { type: "custom", name: "apply_patch" },
      parallel_tool_calls: false,
      input: [
        { type: "custom_tool_call", name: "apply_patch", call_id: "call.with.dots", input: patch },
        { type: "custom_tool_call_output", call_id: "call.with.dots", output: [image] },
        { type: "function_call_output", call_id: "call_2", output: [image] },
      ],
    });

    expect(request.tools).toMatchObject([
      {
        type: "function",
        name: "apply_patch",
        parameters: { properties: { input: { type: "string" } } },
      },
      {
        type: "namespace",
        name: "mcp",
        tools: [{ type: "function", name: "read", parameters: { oneOf: [{ type: "object" }] } }],
      },
    ]);
    expect((request.tools as Record<string, unknown>[])[0]).not.toHaveProperty("format");
    expect(request.tool_choice).toEqual({ type: "function", name: "apply_patch" });
    expect(request.parallel_tool_calls).toBe(false);
    expect(request.input).toEqual([
      {
        type: "function_call",
        name: "apply_patch",
        call_id: "call.with.dots",
        arguments: argumentJson,
      },
      { type: "function_call_output", call_id: "call.with.dots", output: [image] },
      { type: "function_call_output", call_id: "call_2", output: [image] },
    ]);
  });

  it("buffers escaped JSON arguments and emits the Codex custom input events", () => {
    const bridge = createResponsesToolBridge(route, tools)!;
    const added = bridge.event(
      JSON.stringify({
        type: "response.output_item.added",
        output_index: 0,
        item: { ...wireCall, arguments: "", status: "in_progress" },
      }),
    );
    expect(JSON.parse(added[0]!)).toMatchObject({
      type: "response.output_item.added",
      item: { type: "custom_tool_call", name: "apply_patch", input: "" },
    });
    expect(JSON.parse(added[0]!).item).not.toHaveProperty("arguments");
    for (const delta of ['{"input":"*** Begin', ' Patch\\n*** End Patch"}']) {
      expect(
        bridge.event(
          JSON.stringify({
            type: "response.function_call_arguments.delta",
            item_id: "fc_1",
            output_index: 0,
            delta,
          }),
        ),
      ).toEqual([]);
    }
    const finished = bridge
      .event(
        JSON.stringify({
          type: "response.function_call_arguments.done",
          item_id: "fc_1",
          output_index: 0,
          arguments: argumentJson,
        }),
      )
      .map((event) => JSON.parse(event));
    expect(finished).toMatchObject([
      { type: "response.custom_tool_call_input.delta", item_id: "fc_1", delta: patch },
      { type: "response.custom_tool_call_input.done", item_id: "fc_1", input: patch },
    ]);
    expect(
      bridge
        .event(
          JSON.stringify({ type: "response.output_item.done", output_index: 0, item: wireCall }),
        )
        .map((event) => JSON.parse(event)),
    ).toMatchObject([
      {
        type: "response.output_item.done",
        item: { type: "custom_tool_call", input: patch, call_id: "call_1" },
      },
    ]);
    const complete = bridge.event(
      JSON.stringify({
        type: "response.completed",
        response: {
          id: "resp_1",
          output: [
            wireCall,
            {
              type: "function_call",
              id: "fc_2",
              call_id: "call_2",
              name: "read",
              namespace: "mcp",
              arguments: "{}",
            },
          ],
        },
      }),
    );
    expect(JSON.parse(complete[0]!).response.output).toMatchObject([
      { type: "custom_tool_call", name: "apply_patch", input: patch },
      { type: "function_call", namespace: "mcp", name: "read", arguments: "{}" },
    ]);
  });

  it("recovers a custom input delta from output_item.done when arguments.done is absent", () => {
    const bridge = createResponsesToolBridge(route, tools)!;
    bridge.event(
      JSON.stringify({
        type: "response.output_item.added",
        output_index: 0,
        item: { ...wireCall, arguments: "" },
      }),
    );
    const events = bridge
      .event(JSON.stringify({ type: "response.output_item.done", output_index: 0, item: wireCall }))
      .map((event) => JSON.parse(event));
    expect(events.map((event) => event.type)).toEqual([
      "response.custom_tool_call_input.delta",
      "response.custom_tool_call_input.done",
      "response.output_item.done",
    ]);
    expect(events[0].delta).toBe(patch);
  });

  it("keeps namespaced custom calls namespaced on the wire and in Codex output", () => {
    const namespaced = [
      {
        type: "namespace",
        name: "workspace",
        tools: [{ type: "custom", name: "edit" }],
      },
    ];
    const bridge = createResponsesToolBridge(route, namespaced)!;
    expect(
      bridge.request({
        tools: namespaced,
        tool_choice: { type: "custom", namespace: "workspace", name: "edit" },
      }),
    ).toMatchObject({
      tools: [
        { type: "namespace", name: "workspace", tools: [{ type: "function", name: "edit" }] },
      ],
      tool_choice: { type: "function", namespace: "workspace", name: "edit" },
    });
    const event = bridge.event(
      JSON.stringify({
        type: "response.output_item.done",
        item: {
          type: "function_call",
          id: "fc_2",
          call_id: "call_2",
          namespace: "workspace",
          name: "edit",
          arguments: '{"input":"patch"}',
        },
      }),
    );
    expect(JSON.parse(event.at(-1)!)).toMatchObject({
      type: "response.output_item.done",
      item: { type: "custom_tool_call", namespace: "workspace", name: "edit", input: "patch" },
    });
  });

  it("leaves passthrough function declarations without schemas unchanged", () => {
    const declarations = [
      { type: "custom", name: "apply_patch" },
      { type: "function", name: "ping" },
    ];
    const bridge = createResponsesToolBridge(route, declarations)!;
    expect(bridge.request({ tools: declarations }).tools).toMatchObject([
      {
        type: "function",
        name: "apply_patch",
        parameters: { properties: { input: { type: "string" } } },
      },
      { type: "function", name: "ping" },
    ]);
    expect(
      (bridge.request({ tools: declarations }).tools as Record<string, unknown>[])[1],
    ).not.toHaveProperty("parameters");
  });

  it("uses buffered deltas when the final item omits completed arguments", () => {
    const bridge = createResponsesToolBridge(route, tools)!;
    bridge.event(
      JSON.stringify({
        type: "response.output_item.added",
        output_index: 0,
        item: { ...wireCall, status: "in_progress", arguments: "" },
      }),
    );
    bridge.event(
      JSON.stringify({
        type: "response.function_call_arguments.delta",
        item_id: "fc_1",
        delta: argumentJson,
      }),
    );
    const events = bridge
      .event(
        JSON.stringify({
          type: "response.output_item.done",
          output_index: 0,
          item: { ...wireCall, arguments: "" },
        }),
      )
      .map((event) => JSON.parse(event));
    expect(events.at(-1)?.item).toMatchObject({ type: "custom_tool_call", input: patch });
  });
});
