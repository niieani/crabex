import { afterEach, describe, expect, it } from "vite-plus/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NativeRoutedAgentsBridge, RoutedAgentRegistry } from "./native-routed-agents.ts";

const collaboration = {
  type: "namespace",
  name: "collaboration",
  description: "Native encrypted agent tools",
  tools: [
    ...["spawn_agent", "send_message", "followup_task"].map((name) => ({
      type: "function",
      name,
      strict: false,
      parameters: {
        type: "object",
        properties: {
          message: { type: "string", encrypted: true },
          ...(name === "spawn_agent"
            ? { model: { type: "string" }, task_name: { type: "string" } }
            : { target: { type: "string" } }),
        },
        required: name === "spawn_agent" ? ["message", "task_name"] : ["message", "target"],
        additionalProperties: false,
      },
    })),
    { type: "function", name: "wait_agent", parameters: { type: "object" } },
  ],
};

const models = ["glm-5.3-flash", "anthropic.claude-haiku-4-5"];
const scope = "session/thread/account";
const item = (name: string, callId: string, args: Record<string, unknown>) => ({
  type: "function_call",
  id: `fc_${callId}`,
  call_id: callId,
  namespace: "routed_agents",
  name,
  arguments: JSON.stringify(args),
});
const event = (type: string, outputItem: Record<string, unknown>) =>
  JSON.stringify({ type, output_index: 0, item: outputItem });

describe("native routed-agent variant", () => {
  it("resolves a relative target from the caller branch and refuses an unknown caller path", () => {
    const registry = new RoutedAgentRegistry();
    registry.rememberSpawn(scope, "call_a", "worker", "glm-5.3-flash");
    registry.observeSpawnOutput(scope, "call_a", '{"task_name":"/root/a/worker"}');
    registry.rememberSpawn(scope, "call_b", "worker", "gpt-5.6-luna");
    registry.observeSpawnOutput(scope, "call_b", '{"task_name":"/root/b/worker"}');
    const send = item("send_message", "call_send", { target: "worker", message: "Hello" });

    const routedCaller = new NativeRoutedAgentsBridge(models, scope, registry, "/root/a");
    expect(
      JSON.parse(routedCaller.event(event("response.output_item.done", send))).item,
    ).toMatchObject({
      namespace: "collaboration",
      encrypted_function_args: [],
    });
    const nativeCaller = new NativeRoutedAgentsBridge(models, scope, registry, "/root/b");
    expect(() => nativeCaller.event(event("response.output_item.done", send))).toThrow(
      'target "worker" is not a known plaintext-class agent',
    );
    const unknownCaller = new NativeRoutedAgentsBridge(models, scope, registry);
    expect(() => unknownCaller.event(event("response.output_item.done", send))).toThrow(
      'cannot resolve relative target "worker" without a caller path',
    );
  });

  it("adds plaintext copies without changing reserved tools, and rehashes Responses Lite IDs", () => {
    const bridge = new NativeRoutedAgentsBridge(
      [
        { slug: "glm-5.3-flash", guidance: "fast local checks" },
        { slug: "anthropic.claude-haiku-4-5" },
      ],
      scope,
      new RoutedAgentRegistry(),
      undefined,
      "Prefer short tasks.",
    );
    const original = structuredClone(collaboration);
    const top = bridge.request({ tools: [collaboration], input: [] });
    expect(collaboration).toEqual(original);
    expect((top.tools as unknown[])[0]).toEqual(original);
    const variant = (top.tools as Record<string, unknown>[])[1] as {
      name: string;
      tools: {
        name: string;
        parameters: { properties: Record<string, unknown>; required: string[] };
      }[];
    };
    expect(variant.name).toBe("routed_agents");
    expect(variant).toHaveProperty(
      "description",
      expect.stringContaining("glm-5.3-flash (fast local checks)"),
    );
    expect(variant).toHaveProperty("description", expect.stringContaining("Prefer short tasks."));
    expect(String((top as { instructions?: string }).instructions)).toContain(
      "identical parameters and delegation rules",
    );
    expect(String((top as { instructions?: string }).instructions)).toContain(
      "Prefer short tasks.",
    );
    expect(String((top as { instructions?: string }).instructions)).not.toContain("plaintext");
    expect(variant.tools.map((tool) => tool.name)).toEqual([
      "spawn_agent",
      "send_message",
      "followup_task",
    ]);
    expect(variant.tools[0]?.parameters.properties.message).not.toHaveProperty("encrypted");
    expect(variant.tools[0]?.parameters.properties.model).toMatchObject({
      enum: [...models].sort(),
    });
    expect(variant.tools[0]?.parameters.required).toContain("model");
    expect((top.tools as unknown[])[0]).toEqual(original);
    expect((top.tools as unknown[])[0]).toEqual(collaboration);

    const lite = {
      type: "additional_tools",
      id: "at_original",
      role: "developer",
      tools: [collaboration],
    };
    const first = bridge.request({ input: [lite] });
    const second = bridge.request({ input: [lite] });
    const changed = (first.input as { id: string; tools: unknown[] }[])[0]!;
    expect(changed.id).toMatch(/^at_[0-9a-f-]{36}$/);
    expect(changed.id).not.toBe("at_original");
    expect(changed.id).toBe((second.input as { id: string }[])[0]?.id);
    expect(changed.tools).toHaveLength(2);
    expect(lite.id).toBe("at_original");
  });

  it("maps routed calls for Codex and restores their wire namespace on replay", () => {
    const registry = new RoutedAgentRegistry();
    const bridge = new NativeRoutedAgentsBridge(models, scope, registry);
    bridge.request({ tools: [collaboration], input: [] });
    const spawn = item("spawn_agent", "call_spawn", {
      task_name: "worker",
      model: "glm-5.3-flash",
      message: "Reply exactly OK",
    });
    const added = JSON.parse(
      bridge.event(event("response.output_item.added", { ...spawn, arguments: "" })),
    );
    expect(added.item).toMatchObject({
      namespace: "collaboration",
      name: "spawn_agent",
      encrypted_function_args: [],
    });
    const done = JSON.parse(bridge.event(event("response.output_item.done", spawn)));
    expect(done.item.encrypted_function_args).toEqual([]);
    const completed = JSON.parse(
      bridge.event(JSON.stringify({ type: "response.completed", response: { output: [spawn] } })),
    );
    expect(completed.response.output[0].namespace).toBe("collaboration");
    expect(completed.response.output[0].encrypted_function_args).toEqual([]);

    const replay = bridge.request({
      input: [
        done.item,
        {
          type: "function_call_output",
          call_id: "call_spawn",
          output: '{"task_name":"/root/worker"}',
        },
      ],
      tools: [collaboration],
    });
    expect((replay.input as Record<string, unknown>[])[0]).toMatchObject({
      namespace: "routed_agents",
      name: "spawn_agent",
    });
    expect((replay.input as Record<string, unknown>[])[0]).not.toHaveProperty(
      "encrypted_function_args",
    );
    expect(registry.targetModel(scope, "/root/worker")).toBe("glm-5.3-flash");

    const send = item("send_message", "call_send", {
      target: "/root/worker",
      message: "Follow up",
    });
    expect(JSON.parse(bridge.event(event("response.output_item.done", send))).item).toMatchObject({
      namespace: "collaboration",
      encrypted_function_args: [],
    });
    expect(() =>
      bridge.event(
        event(
          "response.output_item.done",
          item("followup_task", "call_bad", { target: "/root/native", message: "Wrong child" }),
        ),
      ),
    ).toThrow(
      'routed_agents.followup_task target "/root/native" is not a known plaintext-class agent',
    );
    const native = {
      ...spawn,
      namespace: "collaboration",
      arguments: '{"message":"ciphertext"}',
    };
    expect(JSON.parse(bridge.event(event("response.output_item.done", native))).item).toEqual(
      native,
    );
  });

  it("omits the variant without routed models and keeps original calls intact", () => {
    const bridge = new NativeRoutedAgentsBridge([], scope, new RoutedAgentRegistry());
    const original = { tools: [collaboration], input: [] };
    expect(bridge.request(original)).toEqual(original);
    expect(bridge.event(event("response.output_item.done", item("spawn_agent", "x", {})))).toBe(
      event("response.output_item.done", item("spawn_agent", "x", {})),
    );
  });
});

describe("routed-agent registry", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("survives restart with only hashed scope keys on disk", async () => {
    const dir = await mkdtemp(join(tmpdir(), "act-routed-agents-"));
    dirs.push(dir);
    const path = join(dir, "routed-agents-cache.json");
    const first = await RoutedAgentRegistry.open(path);
    first.rememberSpawn(scope, "call_spawn", "worker", "glm-5.3-flash");
    first.observeSpawnOutput(scope, "call_spawn", '{"task_name":"/root/worker"}');
    await first.flush();
    const second = await RoutedAgentRegistry.open(path);
    expect(second.targetModel(scope, "/root/worker")).toBe("glm-5.3-flash");
    const resumed = new NativeRoutedAgentsBridge(models, scope, second);
    resumed.request({ tools: [collaboration], input: [] });
    expect(
      JSON.parse(
        resumed.event(
          event(
            "response.output_item.done",
            item("followup_task", "call_followup", {
              target: "/root/worker",
              message: "Resume after restart",
            }),
          ),
        ),
      ).item,
    ).toMatchObject({ namespace: "collaboration", encrypted_function_args: [] });
    const content = await Bun.file(path).text();
    expect(content).not.toContain(scope);
  });

  it("shares custom parent and sibling paths with a native child without exposing native targets", async () => {
    const dir = await mkdtemp(join(tmpdir(), "act-routed-tree-"));
    dirs.push(dir);
    const path = join(dir, "routed-agents-cache.json");
    const rootHeaders = new Headers({
      "chatgpt-account-id": "account-a",
      "thread-id": "root-thread",
      "session-id": "root-thread",
    });
    const childHeaders = new Headers({
      "chatgpt-account-id": "account-a",
      "thread-id": "child-thread",
      "session-id": "child-thread",
      "x-codex-parent-thread-id": "root-thread",
    });
    const first = await RoutedAgentRegistry.open(path);
    const rootScope = first.observeAgent(rootHeaders, "glm-5.3-flash", { input: [] });
    const childScope = first.observeAgent(childHeaders, "gpt-5.6-luna", {
      input: [
        {
          type: "agent_message",
          author: "/root",
          recipient: "/root/native_child",
          content: [{ type: "input_text", text: "Reply OK" }],
        },
      ],
    });
    expect(childScope).toBe(rootScope);
    expect(first.targetModel(childScope!, "/root")).toBe("glm-5.3-flash");
    expect(first.targetModel(childScope!, "/root/native_child")).toBe("gpt-5.6-luna");
    await first.flush();

    const second = await RoutedAgentRegistry.open(path);
    expect(second.callerPath(childHeaders, { input: [] })).toBe("/root/native_child");
    const bridge = new NativeRoutedAgentsBridge(
      models,
      childScope!,
      second,
      second.callerPath(childHeaders, { input: [] }),
    );
    const mapped = JSON.parse(
      bridge.event(
        event(
          "response.output_item.done",
          item("send_message", "call_parent", { target: "/root", message: "Plain reply" }),
        ),
      ),
    );
    expect(mapped.item).toMatchObject({
      namespace: "collaboration",
      name: "send_message",
      encrypted_function_args: [],
    });
    expect(() =>
      bridge.event(
        event(
          "response.output_item.done",
          item("followup_task", "call_native", {
            target: "/root/native_child",
            message: "Wrong target",
          }),
        ),
      ),
    ).toThrow("is not a known plaintext-class agent");
    expect(await Bun.file(path).text()).not.toContain("account-a");
  });

  it("links Responses Lite child metadata to a routed parent after restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "routed-agent-lite-"));
    const path = join(directory, "agents.json");
    try {
      const headers = new Headers({ authorization: "Bearer account-secret" });
      const first = await RoutedAgentRegistry.open(path);
      const root = first.observeAgent(
        headers,
        "glm-5.3-flash",
        {
          client_metadata: { thread_id: "root-thread" },
          input: [],
        },
        "responses:fireworks",
      );
      await first.flush();
      const second = await RoutedAgentRegistry.open(path);
      const child = {
        client_metadata: {
          thread_id: "native-child",
          "x-codex-parent-thread-id": "root-thread",
        },
        input: [
          {
            type: "agent_message",
            author: "/root",
            recipient: "/root/native_child",
            content: [
              { type: "input_text", text: "Message Type: NEW_TASK\nPayload:\nReport back" },
            ],
          },
        ],
      };
      expect(second.sourceFamily(headers, child)).toBe("responses:fireworks");
      expect(second.observeAgent(headers, "gpt-5.6-luna", child, "native-chatgpt")).toBe(root);
      expect(second.targetModel(root!, "/root")).toBe("glm-5.3-flash");
      expect(second.sourceFamily(headers, child)).toBe("responses:fireworks");
      expect(
        second.sourceFamily(headers, {
          client_metadata: child.client_metadata,
          input: [{ type: "function_call_output", call_id: "call_1", output: "done" }],
        }),
      ).toBe("native-chatgpt");
      expect(await Bun.file(path).text()).not.toContain("account-secret");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
