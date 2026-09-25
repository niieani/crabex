import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import WebSocket, { type RawData, WebSocketServer } from "ws";

import type { CaptureEvent, CaptureSink } from "../recording/capture.ts";
import type { ConfigBundleOverride } from "../config/config-bundle-store.ts";
import type { ProxyConfigStore } from "../config/proxy-config-store.ts";
import type {
  UpstreamCacheKind,
  UpstreamCacheState,
  UpstreamCacheStore,
} from "../config/upstream-cache.ts";
import type { Transformation } from "../context/transformation.ts";
import type { ModelAdjustment, ModelRoute, ModelRouteConfig } from "../routing/model-routes.ts";
import { modelRouteFromConfig } from "../routing/model-routes.ts";
import type { ModelDefinition } from "../routing/model-list.ts";
import { LiveRequestStore } from "../requests/live-request-store.ts";
import { parseSseEvents } from "./responses-bridge.ts";
import { sanitizeCloseCode, startReverseProxy, type RunningProxy } from "./server.ts";

class MemoryCaptureSink implements CaptureSink {
  readonly events: CaptureEvent[] = [];

  async record(event: CaptureEvent): Promise<void> {
    this.events.push(event);
  }
}

const closeables: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closeables.splice(0).map((close) => close()));
});

describe("subscription reverse proxy", () => {
  it("forwards an HTTP Responses request with OAuth headers and records only its body", async () => {
    const requestBody = '{"model":"gpt-5.6","input":"hello"}';
    const upstream = await startHttpServer(async (request, response) => {
      expect(request.url).toBe("/backend-api/codex/responses?trace=1");
      expect(request.headers.authorization).toBe("Bearer oauth-secret");
      expect(request.headers["chatgpt-account-id"]).toBe("workspace-123");
      expect(await readBody(request)).toEqual(Buffer.from(requestBody));

      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write('data: {"type":"response.output_text.delta"}\n\n');
      response.end("data: [DONE]\n\n");
    });
    const captures = new MemoryCaptureSink();
    const proxy = await startProxy(upstream.origin, captures);

    const response = await fetch(`${proxy.origin}/backend-api/codex/responses?trace=1`, {
      method: "POST",
      headers: {
        authorization: "Bearer oauth-secret",
        "chatgpt-account-id": "workspace-123",
        "content-type": "application/json",
      },
      body: requestBody,
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(
      'data: {"type":"response.output_text.delta"}\n\ndata: [DONE]\n\n',
    );
    expect(captures.events).toMatchObject([
      {
        transport: "http",
        direction: "client_to_upstream",
        payload: requestBody,
        origin: {
          kind: "chatgpt-http",
          url: expect.stringContaining("/backend-api/codex/responses"),
        },
      },
    ]);
    expect(JSON.stringify(captures.events)).not.toContain("oauth-secret");
  });

  it("preserves encrypted collaboration calls on a native-encrypted Responses route", async () => {
    const declaration = collaborationDeclaration();
    const call = {
      type: "function_call",
      id: "fc_spawn",
      call_id: "call_spawn",
      namespace: "collaboration",
      name: "spawn_agent",
      arguments: '{"message":"ciphertext"}',
      encrypted_function_args: ["ciphertext"],
    };
    let outbound: Record<string, unknown> | undefined;
    const upstream = await startHttpServer(async (request, response) => {
      outbound = JSON.parse((await readBody(request)).toString()) as Record<string, unknown>;
      response.writeHead(200, { "content-type": "text/event-stream" });
      for (const event of [
        { type: "response.output_item.added", output_index: 0, item: call },
        { type: "response.output_item.done", output_index: 0, item: call },
        { type: "response.completed", response: { output: [call] } },
      ])
        response.write(`data: ${JSON.stringify(event)}\n\n`);
      response.end();
    });
    const original = process.env.ACT_TEST_ROUTE_KEY;
    process.env.ACT_TEST_ROUTE_KEY = "local-api-key";
    try {
      const route = modelRouteFromConfig({
        ...routeConfigForTest(upstream.origin),
        transport: "http",
        handoff_class: "native-encrypted",
      });
      const proxy = await startRoutingProxy(upstream.origin, new MemoryCaptureSink(), {
        routes: [route, routedChildRoute(upstream.origin)],
        proxyConfigSource: routedAgentsConfig(),
      });
      const response = await fetch(`${proxy.origin}/backend-api/codex/responses`, {
        method: "POST",
        headers: {
          authorization: "Bearer oauth-secret",
          "chatgpt-account-id": "account-1",
          "thread-id": "thread-1",
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: "kimi-k3", input: [], tools: [declaration], stream: true }),
      });
      const events = (await Array.fromAsync(parseSseEvents(response.body!))).map((entry) =>
        JSON.parse(entry),
      );
      expect(response.status).toBe(200);
      expect((outbound!.tools as unknown[])[0]).toEqual(declaration);
      expect((outbound!.tools as { name: string }[])[1].name).toBe("routed_agents");
      expect(events.find((event) => event.type === "response.output_item.added")?.item).toEqual(
        call,
      );
      expect(events.find((event) => event.type === "response.output_item.done")?.item).toEqual(
        call,
      );
      expect(
        events.find((event) => event.type === "response.completed")?.response.output[0],
      ).toEqual(call);
    } finally {
      if (original === undefined) delete process.env.ACT_TEST_ROUTE_KEY;
      else process.env.ACT_TEST_ROUTE_KEY = original;
    }
  });

  it("adds routed agent tools on native HTTP and restores plaintext calls through replay", async () => {
    const seen: Record<string, unknown>[] = [];
    const spawn = {
      type: "function_call",
      id: "fc_spawn",
      call_id: "call_spawn",
      namespace: "routed_agents",
      name: "spawn_agent",
      arguments: JSON.stringify({
        task_name: "worker",
        model: "glm-5.3-flash",
        message: "Reply OK",
      }),
    };
    const send = {
      type: "function_call",
      id: "fc_send",
      call_id: "call_send",
      namespace: "routed_agents",
      name: "send_message",
      arguments: JSON.stringify({ target: "/root/worker", message: "Follow up" }),
    };
    const upstream = await startHttpServer(async (request, response) => {
      seen.push(JSON.parse((await readBody(request)).toString()) as Record<string, unknown>);
      const call =
        seen.length === 1
          ? spawn
          : seen.length === 2
            ? send
            : { ...send, arguments: '{"target":"/root/native","message":"Wrong target"}' };
      response.writeHead(200);
      for (const event of [
        { type: "response.output_item.added", output_index: 0, item: { ...call, arguments: "" } },
        { type: "response.output_item.done", output_index: 0, item: call },
        { type: "response.completed", response: { output: [call] } },
      ])
        response.write(`data: ${JSON.stringify(event)}\n\n`);
      response.end();
    });
    const route = routedChildRoute(upstream.origin);
    const encryptedConfig = routeConfigForTest(upstream.origin);
    const encryptedRoute = modelRouteFromConfig({
      ...encryptedConfig,
      transport: "http",
      handoff_class: "native-encrypted",
      model: { ...encryptedConfig.model, slug: "gateway-child" },
    });
    const proxy = await startRoutingProxy(upstream.origin, new MemoryCaptureSink(), {
      routes: [route, encryptedRoute],
      proxyConfigSource: routedAgentsConfig(),
    });
    const identity = {
      authorization: "Bearer oauth-secret",
      "chatgpt-account-id": "account-1",
      "session-id": "session-1",
      "thread-id": "thread-1",
      "content-type": "application/json",
    };
    const tools = [collaborationDeclaration()];
    const first = await fetch(`${proxy.origin}/backend-api/codex/responses`, {
      method: "POST",
      headers: identity,
      body: JSON.stringify({ model: "gpt-5.6-luna", input: [], tools, stream: true }),
    });
    const firstEvents = (await Array.fromAsync(parseSseEvents(first.body!))).map((entry) =>
      JSON.parse(entry),
    );
    const done = firstEvents.find((event) => event.type === "response.output_item.done")?.item;
    expect(first.status).toBe(200);
    expect((seen[0]!.tools as { name: string }[]).map((tool) => tool.name)).toEqual([
      "collaboration",
      "routed_agents",
    ]);
    const variant = (
      seen[0]!.tools as { tools?: { name: string; parameters: Record<string, unknown> }[] }[]
    )[1]!;
    const spawnDeclaration = variant.tools?.find((tool) => tool.name === "spawn_agent");
    expect(spawnDeclaration?.parameters.properties).toMatchObject({
      model: { enum: ["glm-5.3-flash"] },
    });
    expect(done).toMatchObject({ namespace: "collaboration", encrypted_function_args: [] });
    expect(firstEvents.at(-1)?.response.output[0]).toMatchObject({
      namespace: "collaboration",
      encrypted_function_args: [],
    });
    const second = await fetch(`${proxy.origin}/backend-api/codex/responses`, {
      method: "POST",
      headers: identity,
      body: JSON.stringify({
        model: "gpt-5.6-luna",
        input: [
          done,
          {
            type: "function_call_output",
            call_id: "call_spawn",
            output: '{"task_name":"/root/worker"}',
          },
        ],
        tools,
        stream: true,
      }),
    });
    const secondEvents = (await Array.fromAsync(parseSseEvents(second.body!))).map((entry) =>
      JSON.parse(entry),
    );
    expect(second.status).toBe(200);
    expect((seen[1]!.input as Record<string, unknown>[])[0]).toMatchObject({
      namespace: "routed_agents",
    });
    expect(
      secondEvents.find((event) => event.type === "response.output_item.done")?.item,
    ).toMatchObject({
      namespace: "collaboration",
      name: "send_message",
      encrypted_function_args: [],
    });
    const wrongTarget = await fetch(`${proxy.origin}/backend-api/codex/responses`, {
      method: "POST",
      headers: identity,
      body: JSON.stringify({ model: "gpt-5.6-luna", input: [], tools, stream: true }),
    });
    const failure = (await Array.fromAsync(parseSseEvents(wrongTarget.body!))).map((entry) =>
      JSON.parse(entry),
    );
    expect(failure.at(-1)).toMatchObject({
      type: "error",
      status: 422,
      error: {
        message: expect.stringContaining(
          'target "/root/native" is not a known plaintext-class agent',
        ),
      },
    });
  });

  it("lets a routed encrypted Responses parent spawn and follow up with a plaintext-class child over HTTP", async () => {
    process.env.ACT_TEST_ROUTE_KEY = "test-provider-key";
    try {
      const seen: Record<string, unknown>[] = [];
      const spawn = {
        type: "function_call",
        id: "fc_routed_spawn",
        call_id: "call_routed_spawn",
        namespace: "routed_agents",
        name: "spawn_agent",
        arguments: JSON.stringify({
          task_name: "worker",
          model: "glm-5.3-flash",
          message: "Reply OK",
        }),
      };
      const followup = {
        ...spawn,
        id: "fc_routed_followup",
        call_id: "call_routed_followup",
        name: "followup_task",
        arguments: JSON.stringify({ target: "/root/worker", message: "Continue" }),
      };
      const gateway = await startHttpServer(async (request, response) => {
        seen.push(JSON.parse((await readBody(request)).toString()) as Record<string, unknown>);
        const call = seen.length === 1 ? spawn : followup;
        response.writeHead(200, { "content-type": "text/event-stream" });
        for (const event of [
          { type: "response.output_item.added", output_index: 0, item: { ...call, arguments: "" } },
          { type: "response.output_item.done", output_index: 0, item: call },
          { type: "response.completed", response: { output: [call] } },
        ])
          response.write(`data: ${JSON.stringify(event)}\n\n`);
        response.end();
      });
      const gatewayConfig = routeConfigForTest(gateway.origin);
      const parent = modelRouteFromConfig({
        ...gatewayConfig,
        transport: "http",
        handoff_class: "native-encrypted",
        model: { ...gatewayConfig.model, slug: "gateway-parent" },
      });
      const proxy = await startRoutingProxy(gateway.origin, new MemoryCaptureSink(), {
        routes: [parent, routedChildRoute(gateway.origin)],
        proxyConfigSource: routedAgentsConfig(),
      });
      const headers = {
        authorization: "Bearer client-token",
        "chatgpt-account-id": "account-1",
        "session-id": "session-1",
        "thread-id": "thread-1",
        "content-type": "application/json",
      };
      const tools = [collaborationDeclaration()];
      const first = await fetch(`${proxy.origin}/backend-api/codex/responses`, {
        method: "POST",
        headers,
        body: JSON.stringify({ model: "gateway-parent", input: [], tools, stream: true }),
      });
      const firstEvents = (await Array.fromAsync(parseSseEvents(first.body!))).map((entry) =>
        JSON.parse(entry),
      );
      const call = firstEvents.find((event) => event.type === "response.output_item.done")?.item;
      expect(first.status).toBe(200);
      expect((seen[0]!.tools as { name: string }[]).map((tool) => tool.name)).toEqual([
        "collaboration",
        "routed_agents",
      ]);
      expect((seen[0]!.tools as unknown[])[0]).toEqual(tools[0]);
      expect(seen[0]?.instructions).toContain("use routed_agents instead of collaboration");
      expect(call).toMatchObject({ namespace: "collaboration", encrypted_function_args: [] });
      expect(firstEvents.at(-1)?.response.output[0]).toMatchObject({
        namespace: "collaboration",
        encrypted_function_args: [],
      });

      const second = await fetch(`${proxy.origin}/backend-api/codex/responses`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: "gateway-parent",
          input: [
            call,
            {
              type: "function_call_output",
              call_id: "call_routed_spawn",
              output: '{"task_name":"/root/worker"}',
            },
          ],
          tools,
          stream: true,
        }),
      });
      const secondEvents = (await Array.fromAsync(parseSseEvents(second.body!))).map((entry) =>
        JSON.parse(entry),
      );
      expect(second.status).toBe(200);
      expect((seen[1]!.input as Record<string, unknown>[])[0]).toMatchObject({
        namespace: "routed_agents",
        name: "spawn_agent",
      });
      expect(
        secondEvents.find((event) => event.type === "response.output_item.done")?.item,
      ).toMatchObject({
        namespace: "collaboration",
        name: "followup_task",
        encrypted_function_args: [],
      });
    } finally {
      delete process.env.ACT_TEST_ROUTE_KEY;
    }
  });

  it("translates routed agent calls on bridged WebSocket and continues the visible call over HTTP", async () => {
    process.env.ACT_TEST_ROUTE_KEY = "test-provider-key";
    try {
      const seen: Record<string, unknown>[] = [];
      const spawn = {
        type: "function_call",
        id: "fc_gateway_spawn",
        call_id: "call_gateway_spawn",
        namespace: "routed_agents",
        name: "spawn_agent",
        arguments: JSON.stringify({
          task_name: "worker",
          model: "glm-5.3-flash",
          message: "Reply OK",
        }),
      };
      const followup = {
        ...spawn,
        id: "fc_gateway_followup",
        call_id: "call_gateway_followup",
        name: "followup_task",
        arguments: JSON.stringify({ target: "/root/worker", message: "Continue" }),
      };
      const gateway = await startHttpServer(async (request, response) => {
        seen.push(JSON.parse((await readBody(request)).toString()) as Record<string, unknown>);
        const call = seen.length === 1 ? spawn : followup;
        const id = `resp_${seen.length}`;
        response.writeHead(200, { "content-type": "text/event-stream" });
        for (const event of [
          { type: "response.created", response: { id } },
          { type: "response.output_item.added", output_index: 0, item: { ...call, arguments: "" } },
          { type: "response.output_item.done", output_index: 0, item: call },
          { type: "response.completed", response: { id, output: [call] } },
        ])
          response.write(`data: ${JSON.stringify(event)}\n\n`);
        response.end();
      });
      const config = routeConfigForTest(gateway.origin);
      const parent = modelRouteFromConfig({
        ...config,
        transport: "http",
        handoff_class: "native-encrypted",
        bridge_response_state: "stored",
        model: { ...config.model, slug: "gateway-parent" },
      });
      const proxy = await startRoutingProxy(gateway.origin, new MemoryCaptureSink(), {
        routes: [parent, routedChildRoute(gateway.origin)],
        proxyConfigSource: routedAgentsConfig(),
      });
      const identity = {
        authorization: "Bearer client-token",
        "chatgpt-account-id": "account-1",
        "session-id": "session-1",
        "thread-id": "thread-1",
      };
      const tools = [collaborationDeclaration()];
      const client = new WebSocket(
        proxy.origin.replace("http://", "ws://") + "/backend-api/codex/responses",
        { headers: identity },
      );
      closeables.push(async () => client.close());
      await opened(client);
      const events: Record<string, unknown>[] = [];
      client.on("message", (raw) => events.push(JSON.parse(rawDataText(raw))));
      client.send(
        JSON.stringify({ type: "response.create", model: "gateway-parent", input: [], tools }),
      );
      await eventually(() =>
        expect(events.some((event) => event.type === "response.completed")).toBe(true),
      );
      expect((seen[0]!.tools as { name: string }[]).map((tool) => tool.name)).toEqual([
        "collaboration",
        "routed_agents",
      ]);
      expect(seen[0]?.instructions).toContain("use routed_agents instead of collaboration");
      const visibleCall = (
        events.find((event) => event.type === "response.output_item.done") as {
          item: Record<string, unknown>;
        }
      ).item;
      expect(visibleCall).toMatchObject({
        namespace: "collaboration",
        name: "spawn_agent",
        encrypted_function_args: [],
      });
      expect(
        (
          events.find((event) => event.type === "response.completed") as {
            response: { output: Record<string, unknown>[] };
          }
        ).response.output[0],
      ).toEqual(visibleCall);

      const second = await fetch(`${proxy.origin}/backend-api/codex/responses`, {
        method: "POST",
        headers: { ...identity, "content-type": "application/json" },
        body: JSON.stringify({
          model: "gateway-parent",
          input: [
            visibleCall,
            {
              type: "function_call_output",
              call_id: "call_gateway_spawn",
              output: '{"task_name":"/root/worker"}',
            },
          ],
          tools,
          stream: true,
        }),
      });
      const secondEvents = (await Array.fromAsync(parseSseEvents(second.body!))).map((entry) =>
        JSON.parse(entry),
      );
      expect(second.status).toBe(200);
      expect(seen[1]).toMatchObject({
        previous_response_id: "resp_1",
        input: [{ type: "function_call_output", call_id: "call_gateway_spawn" }],
      });
      expect(
        secondEvents.find((event) => event.type === "response.output_item.done")?.item,
      ).toMatchObject({
        namespace: "collaboration",
        name: "followup_task",
        encrypted_function_args: [],
      });
    } finally {
      delete process.env.ACT_TEST_ROUTE_KEY;
    }
  });

  it("lets a native child message its routed parent through the plaintext variant", async () => {
    const send = {
      type: "function_call",
      call_id: "call_parent_message",
      namespace: "routed_agents",
      name: "send_message",
      arguments: '{"target":"/root","message":"Grandchild finished"}',
    };
    const upstream = await startHttpServer(async (request, response) => {
      const body = JSON.parse((await readBody(request)).toString()) as { model: string };
      response.writeHead(200, { "content-type": "text/event-stream" });
      const output = body.model === "gpt-5.6-luna" ? [send] : [];
      response.end(
        `data: ${JSON.stringify({ type: "response.completed", response: { output } })}\n\n`,
      );
    });
    const previous = process.env.ACT_TEST_ROUTE_KEY;
    process.env.ACT_TEST_ROUTE_KEY = "local-api-key";
    try {
      const proxy = await startRoutingProxy(upstream.origin, new MemoryCaptureSink(), {
        routes: [routedChildRoute(upstream.origin)],
        proxyConfigSource: routedAgentsConfig(),
      });
      const identity = {
        authorization: "Bearer oauth-secret",
        "chatgpt-account-id": "account-1",
        "content-type": "application/json",
      };
      const root = await fetch(`${proxy.origin}/backend-api/codex/responses`, {
        method: "POST",
        headers: identity,
        body: JSON.stringify({
          model: "glm-5.3-flash",
          client_metadata: { thread_id: "root-thread" },
          input: [message("user", "Start")],
          tools: [],
          stream: true,
        }),
      });
      expect(root.status).toBe(200);
      await root.text();
      const child = await fetch(`${proxy.origin}/backend-api/codex/responses`, {
        method: "POST",
        headers: identity,
        body: JSON.stringify({
          model: "gpt-5.6-luna",
          client_metadata: {
            thread_id: "child-thread",
            "x-codex-parent-thread-id": "root-thread",
          },
          input: [
            {
              type: "agent_message",
              author: "/root",
              recipient: "/root/native_child",
              content: [{ type: "input_text", text: "Report back" }],
            },
          ],
          tools: [collaborationDeclaration()],
          stream: true,
        }),
      });
      const events = (await Array.fromAsync(parseSseEvents(child.body!))).map((entry) =>
        JSON.parse(entry),
      );
      expect(child.status).toBe(200);
      expect(events.at(-1)).toMatchObject({
        type: "response.completed",
        response: {
          output: [
            {
              namespace: "collaboration",
              name: "send_message",
              encrypted_function_args: [],
            },
          ],
        },
      });
    } finally {
      if (previous === undefined) delete process.env.ACT_TEST_ROUTE_KEY;
      else process.env.ACT_TEST_ROUTE_KEY = previous;
    }
  });

  it("sanitizes foreign fork reasoning at native and Responses HTTP boundaries", async () => {
    const seen: Record<string, unknown>[] = [];
    const upstream = await startHttpServer(async (request, response) => {
      seen.push(JSON.parse((await readBody(request)).toString()) as Record<string, unknown>);
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end('data: {"type":"response.completed","response":{"output":[]}}\n\n');
    });
    const previous = process.env.ACT_TEST_ROUTE_KEY;
    process.env.ACT_TEST_ROUTE_KEY = "local-api-key";
    try {
      const proxy = await startRoutingProxy(upstream.origin, new MemoryCaptureSink(), {
        routes: [routedChildRoute(upstream.origin)],
      });
      const headers = {
        authorization: "Bearer oauth-secret",
        "content-type": "application/json",
      };
      const send = (body: Record<string, unknown>) =>
        fetch(`${proxy.origin}/backend-api/codex/responses`, {
          method: "POST",
          headers,
          body: JSON.stringify({ ...body, stream: true }),
        });
      const root = await send({
        model: "glm-5.3-flash",
        client_metadata: { thread_id: "custom-root" },
        input: [message("user", "Start")],
      });
      expect(root.status).toBe(200);
      await root.text();
      const child = await send({
        model: "gpt-5.6-luna",
        client_metadata: {
          thread_id: "native-child",
          "x-codex-parent-thread-id": "custom-root",
        },
        input: [
          { type: "reasoning", encrypted_content: "acta1:foreign" },
          { type: "reasoning", summary: [{ text: "Foreign summary" }] },
          message("assistant", "Safe public answer"),
          {
            type: "agent_message",
            author: "/root",
            recipient: "/root/native_child",
            content: [{ type: "input_text", text: "Message Type: NEW_TASK\nPayload:\nReply" }],
          },
          { type: "reasoning", encrypted_content: "gAAAA-own" },
        ],
      });
      expect(child.status).toBe(200);
      await child.text();
      expect(
        (seen[1]!.input as { type: string; encrypted_content?: string }[]).map((item) => item.type),
      ).toEqual(["message", "agent_message", "reasoning"]);
      expect((seen[1]!.input as { encrypted_content?: string }[])[2]?.encrypted_content).toBe(
        "gAAAA-own",
      );

      const originalTask = {
        type: "agent_message",
        author: "/root",
        recipient: "/root/native_child",
        content: [{ type: "input_text", text: "Message Type: NEW_TASK\nPayload:\nReply" }],
      };
      const followup = await send({
        model: "gpt-5.6-luna",
        client_metadata: {
          thread_id: "native-child",
          "x-codex-parent-thread-id": "custom-root",
        },
        input: [
          { type: "reasoning", encrypted_content: "acta1:foreign" },
          originalTask,
          { type: "reasoning", encrypted_content: "gAAAA-own" },
          {
            ...originalTask,
            content: [{ type: "input_text", text: "Message Type: NEW_TASK\nPayload:\nFollow up" }],
          },
        ],
      });
      expect(followup.status).toBe(200);
      await followup.text();
      expect(seen[2]!.input as { type: string; encrypted_content?: string }[]).toEqual([
        originalTask,
        { type: "reasoning", encrypted_content: "gAAAA-own" },
        {
          ...originalTask,
          content: [{ type: "input_text", text: "Message Type: NEW_TASK\nPayload:\nFollow up" }],
        },
      ]);
      const delta = await send({
        model: "gpt-5.6-luna",
        client_metadata: {
          thread_id: "native-child",
          "x-codex-parent-thread-id": "custom-root",
        },
        input: [{ type: "reasoning", encrypted_content: "gAAAA-own" }],
      });
      expect(delta.status).toBe(200);
      await delta.text();
      expect(seen[3]!.input).toEqual([{ type: "reasoning", encrypted_content: "gAAAA-own" }]);

      const nativeRoot = await send({
        model: "gpt-5.6-luna",
        client_metadata: { thread_id: "native-root" },
        input: [message("user", "Start")],
      });
      expect(nativeRoot.status).toBe(200);
      await nativeRoot.text();
      const customChild = await send({
        model: "glm-5.3-flash",
        client_metadata: {
          thread_id: "custom-child",
          "x-codex-parent-thread-id": "native-root",
        },
        input: [
          { type: "reasoning", encrypted_content: "gAAAA-foreign" },
          message("assistant", "Safe public answer"),
          {
            type: "agent_message",
            author: "/root",
            recipient: "/root/custom_child",
            content: [{ type: "input_text", text: "Message Type: NEW_TASK\nPayload:\nReply" }],
          },
          { type: "reasoning", summary: [{ text: "Own Fireworks summary" }] },
        ],
      });
      expect(customChild.status).toBe(200);
      await customChild.text();
      const customInput = seen[5]!.input as { type: string; content?: unknown[] }[];
      expect(customInput.map((item) => item.type)).toEqual(["message", "message", "reasoning"]);
      expect(JSON.stringify(customInput)).toContain("Safe public answer");
      expect(JSON.stringify(customInput)).not.toContain("gAAAA-foreign");
    } finally {
      if (previous === undefined) delete process.env.ACT_TEST_ROUTE_KEY;
      else process.env.ACT_TEST_ROUTE_KEY = previous;
    }
  });

  it("preserves encrypted replay on a non-agent routed Responses HTTP request", async () => {
    let upstreamInput: unknown;
    const gateway = await startHttpServer(async (request, response) => {
      upstreamInput = (JSON.parse((await readBody(request)).toString()) as { input: unknown })
        .input;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end('data: {"type":"response.completed","response":{"output":[]}}\n\n');
    });
    const previous = process.env.ACT_TEST_ROUTE_KEY;
    process.env.ACT_TEST_ROUTE_KEY = "local-api-key";
    try {
      const config = routeConfigForTest(gateway.origin);
      const route = modelRouteFromConfig({
        ...config,
        api: "responses",
        transport: "http",
        model: { ...config.model, slug: "gpt-6-luna" },
      });
      const proxy = await startRoutingProxy(gateway.origin, new MemoryCaptureSink(), {
        routes: [route],
      });
      const input = [
        { type: "reasoning", encrypted_content: "gAAAA-provider-owned" },
        message("user", "Continue"),
      ];
      const response = await fetch(`${proxy.origin}/backend-api/codex/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-6-luna", input, stream: true }),
      });
      expect(response.status).toBe(200);
      await response.text();
      expect(upstreamInput).toEqual(input);
    } finally {
      if (previous === undefined) delete process.env.ACT_TEST_ROUTE_KEY;
      else process.env.ACT_TEST_ROUTE_KEY = previous;
    }
  });

  it("preserves encrypted replay on a routed Responses WebSocket connection", async () => {
    const upstreamInputs: unknown[] = [];
    const gateway = await startWebSocketServer((socket) => {
      socket.on("message", (raw) => {
        upstreamInputs.push(JSON.parse(rawDataText(raw)).input);
        socket.send(JSON.stringify({ type: "response.completed", response: { output: [] } }));
      });
    });
    const previous = process.env.ACT_TEST_ROUTE_KEY;
    process.env.ACT_TEST_ROUTE_KEY = "local-api-key";
    try {
      const config = routeConfigForTest(gateway.origin);
      const route = modelRouteFromConfig({
        ...config,
        api: "responses",
        transport: "ws",
        model: { ...config.model, slug: "gpt-6-luna" },
      });
      const proxy = await startRoutingProxy(gateway.origin, new MemoryCaptureSink(), {
        routes: [route],
      });
      const client = new WebSocket(
        proxy.origin.replace("http://", "ws://") + "/backend-api/codex/responses",
      );
      closeables.push(async () => client.close());
      await opened(client);
      client.send(
        JSON.stringify({
          type: "response.create",
          model: "gpt-6-luna",
          input: [message("user", "Open socket")],
        }),
      );
      expect(JSON.parse(await nextMessage(client)).type).toBe("response.completed");
      const input = [
        { type: "reasoning", encrypted_content: "gAAAA-provider-owned" },
        message("user", "Continue"),
      ];
      client.send(JSON.stringify({ type: "response.create", model: "gpt-6-luna", input }));
      expect(JSON.parse(await nextMessage(client)).type).toBe("response.completed");
      expect(upstreamInputs[1]).toEqual(input);
    } finally {
      if (previous === undefined) delete process.env.ACT_TEST_ROUTE_KEY;
      else process.env.ACT_TEST_ROUTE_KEY = previous;
    }
  });

  it("preserves native encrypted replay without agent lineage", async () => {
    let upstreamInput: unknown;
    const upstream = await startHttpServer(async (request, response) => {
      upstreamInput = (JSON.parse((await readBody(request)).toString()) as { input: unknown })
        .input;
      response.end("ok");
    });
    const proxy = await startProxy(upstream.origin, new MemoryCaptureSink());
    const input = [
      { type: "reasoning", encrypted_content: "gAAAA-native-owned" },
      message("user", "Continue"),
    ];
    const response = await fetch(`${proxy.origin}/backend-api/codex/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-5.6-luna", input }),
    });
    expect(response.status).toBe(200);
    expect(upstreamInput).toEqual(input);
  });

  it("keeps inherited reasoning across different models in the same provider family", async () => {
    const seen: Record<string, unknown>[] = [];
    const upstream = await startHttpServer(async (request, response) => {
      seen.push(JSON.parse((await readBody(request)).toString()) as Record<string, unknown>);
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end('data: {"type":"response.completed","response":{"output":[]}}\n\n');
    });
    const previous = process.env.ACT_TEST_ROUTE_KEY;
    process.env.ACT_TEST_ROUTE_KEY = "local-api-key";
    try {
      const routeA = routedChildRoute(upstream.origin);
      const routeB = modelRouteFromConfig({
        ...routeConfigForTest(upstream.origin),
        transport: "http",
        model: { ...routeConfigForTest(upstream.origin).model, slug: "glm-5.3" },
      });
      const proxy = await startRoutingProxy(upstream.origin, new MemoryCaptureSink(), {
        routes: [routeA, routeB],
      });
      const headers = { authorization: "Bearer oauth-secret", "content-type": "application/json" };
      const send = async (model: string, thread: string, input: unknown[], parent?: string) => {
        const response = await fetch(`${proxy.origin}/backend-api/codex/responses`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            model,
            client_metadata: {
              thread_id: thread,
              ...(parent === undefined ? {} : { "x-codex-parent-thread-id": parent }),
            },
            input,
            stream: true,
          }),
        });
        expect(response.status).toBe(200);
        await response.text();
      };
      const task = {
        type: "agent_message",
        author: "/root",
        recipient: "/root/child",
        content: [{ type: "input_text", text: "Message Type: NEW_TASK\nPayload:\nContinue" }],
      };
      await send("gpt-6-sol", "native-root", [message("user", "Start")]);
      await send(
        "gpt-5.6-luna",
        "native-child",
        [{ type: "reasoning", encrypted_content: "gAAAA-native" }, task],
        "native-root",
      );
      expect(seen[1]!.input).toEqual([
        { type: "reasoning", encrypted_content: "gAAAA-native" },
        task,
      ]);

      await send("glm-5.3-flash", "fireworks-root", [message("user", "Start")]);
      await send(
        "glm-5.3",
        "fireworks-child",
        [{ type: "reasoning", summary: [{ text: "Fireworks thought" }] }, task],
        "fireworks-root",
      );
      expect((seen[3]!.input as { type: string }[])[0]).toEqual({
        type: "reasoning",
        summary: [{ text: "Fireworks thought" }],
      });
    } finally {
      if (previous === undefined) delete process.env.ACT_TEST_ROUTE_KEY;
      else process.env.ACT_TEST_ROUTE_KEY = previous;
    }
  });

  it("removes native reasoning before Anthropic replay translation", async () => {
    let anthropicBody: Record<string, unknown> | undefined;
    const gateway = await startHttpServer(async (request, response) => {
      const body = JSON.parse((await readBody(request)).toString()) as Record<string, unknown>;
      if (request.url?.includes("/messages")) {
        anthropicBody = body;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            type: "message",
            content: [{ type: "text", text: "done" }],
            stop_reason: "end_turn",
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
        );
      } else {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end('data: {"type":"response.completed","response":{"output":[]}}\n\n');
      }
    });
    const previous = process.env.ACT_TEST_ROUTE_KEY;
    process.env.ACT_TEST_ROUTE_KEY = "local-api-key";
    try {
      const config = routeConfigForTest(gateway.origin);
      const route = modelRouteFromConfig({
        ...config,
        api: "anthropic-messages",
        transport: "http",
        model: { ...config.model, slug: "anthropic.claude-haiku-4-5" },
      });
      const proxy = await startRoutingProxy(gateway.origin, new MemoryCaptureSink(), {
        routes: [route],
      });
      const headers = {
        authorization: "Bearer oauth-secret",
        "content-type": "application/json",
      };
      const parent = await fetch(`${proxy.origin}/backend-api/codex/responses`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: "gpt-5.6-luna",
          client_metadata: { thread_id: "native-root" },
          input: [message("user", "Start")],
          stream: true,
        }),
      });
      expect(parent.status).toBe(200);
      await parent.text();
      const child = await fetch(`${proxy.origin}/backend-api/codex/responses`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: "anthropic.claude-haiku-4-5",
          client_metadata: {
            thread_id: "haiku-child",
            "x-codex-parent-thread-id": "native-root",
          },
          input: [
            { type: "reasoning", encrypted_content: "gAAAA-native" },
            message("assistant", "Public parent context"),
            {
              type: "agent_message",
              author: "/root",
              recipient: "/root/haiku_child",
              content: [{ type: "input_text", text: "Message Type: NEW_TASK\nPayload:\nReply" }],
            },
          ],
          stream: true,
        }),
      });
      expect(child.status).toBe(200);
      expect(await child.text()).toContain("response.completed");
      expect(JSON.stringify(anthropicBody)).toContain("Public parent context");
      expect(JSON.stringify(anthropicBody)).not.toContain("gAAAA-native");
    } finally {
      if (previous === undefined) delete process.env.ACT_TEST_ROUTE_KEY;
      else process.env.ACT_TEST_ROUTE_KEY = previous;
    }
  });

  it("refuses foreign opaque compaction on native HTTP and a routed WebSocket bridge", async () => {
    const native = await startHttpServer((_request, response) => response.end("unexpected"));
    const previous = process.env.ACT_TEST_ROUTE_KEY;
    process.env.ACT_TEST_ROUTE_KEY = "local-api-key";
    try {
      const proxy = await startRoutingProxy(native.origin, new MemoryCaptureSink(), {
        routes: [routedChildRoute("http://127.0.0.1:1")],
      });
      const nativeResponse = await fetch(`${proxy.origin}/backend-api/codex/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "gpt-5.6-luna",
          input: [{ type: "compaction", encrypted_content: "acta1:foreign" }],
        }),
      });
      expect(nativeResponse.status).toBe(422);
      expect(await nativeResponse.text()).toContain("another provider's opaque compaction");

      const client = new WebSocket(
        proxy.origin.replace("http://", "ws://") + "/backend-api/codex/responses",
      );
      closeables.push(async () => client.close());
      await opened(client);
      client.send(
        JSON.stringify({
          type: "response.create",
          model: "glm-5.3-flash",
          input: [{ type: "compaction", encrypted_content: "acta1:foreign" }],
        }),
      );
      expect(JSON.parse(await nextMessage(client))).toMatchObject({
        type: "error",
        status: 422,
        error: { message: expect.stringContaining("another provider's opaque compaction") },
      });
    } finally {
      if (previous === undefined) delete process.env.ACT_TEST_ROUTE_KEY;
      else process.env.ACT_TEST_ROUTE_KEY = previous;
    }
  });

  it("adds routed agent tools and marks calls on a native WebSocket", async () => {
    let upstreamTools: unknown;
    const upstream = await startWebSocketServer((socket) => {
      socket.on("message", (raw) => {
        const request = JSON.parse(rawDataText(raw));
        upstreamTools = request.tools;
        socket.send(
          JSON.stringify({
            type: "response.output_item.done",
            item: {
              type: "function_call",
              call_id: "call_spawn",
              namespace: "routed_agents",
              name: "spawn_agent",
              arguments: '{"task_name":"worker","model":"glm-5.3-flash","message":"OK"}',
            },
          }),
        );
      });
    });
    const proxy = await startRoutingProxy(upstream.origin, new MemoryCaptureSink(), {
      routes: [routedChildRoute(upstream.origin)],
      proxyConfigSource: routedAgentsConfig(),
    });
    const client = new WebSocket(
      proxy.origin.replace("http://", "ws://") + "/backend-api/codex/responses",
      {
        headers: {
          authorization: "Bearer oauth-secret",
          "chatgpt-account-id": "account-1",
          "session-id": "session-1",
          "thread-id": "thread-1",
        },
      },
    );
    closeables.push(async () => client.close());
    await opened(client);
    client.send(
      JSON.stringify({
        type: "response.create",
        model: "gpt-5.6-luna",
        tools: [collaborationDeclaration()],
        input: [],
      }),
    );
    expect(JSON.parse(await nextMessage(client)).item).toMatchObject({
      namespace: "collaboration",
      encrypted_function_args: [],
    });
    expect((upstreamTools as { name: string }[]).map((tool) => tool.name)).toEqual([
      "collaboration",
      "routed_agents",
    ]);
  });

  it("sanitizes proven cross-family reasoning on native WebSocket and the WebSocket-to-HTTP bridge", async () => {
    let nativeInput: unknown;
    let routedInput: unknown;
    const native = await startWebSocketServer((socket) => {
      socket.on("message", (raw) => {
        nativeInput = JSON.parse(rawDataText(raw)).input;
        socket.send(JSON.stringify({ type: "response.completed", response: { output: [] } }));
      });
    });
    const gateway = await startHttpServer(async (request, response) => {
      routedInput = (JSON.parse((await readBody(request)).toString()) as { input: unknown }).input;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end('data: {"type":"response.completed","response":{"output":[]}}\n\n');
    });
    const previous = process.env.ACT_TEST_ROUTE_KEY;
    process.env.ACT_TEST_ROUTE_KEY = "local-api-key";
    try {
      const proxy = await startRoutingProxy(native.origin, new MemoryCaptureSink(), {
        routes: [routedChildRoute(gateway.origin)],
      });
      const url = proxy.origin.replace("http://", "ws://") + "/backend-api/codex/responses";
      const agentHeaders = {
        authorization: "Bearer oauth-secret",
        "chatgpt-account-id": "account-1",
      };
      const nativeClient = new WebSocket(url, { headers: agentHeaders });
      closeables.push(async () => nativeClient.close());
      await opened(nativeClient);
      nativeClient.send(
        JSON.stringify({
          type: "response.create",
          model: "gpt-5.6-luna",
          client_metadata: { thread_id: "native-root" },
          input: [
            { type: "reasoning", encrypted_content: "acta1:foreign" },
            { type: "reasoning", encrypted_content: "gAAAA-own" },
            message("user", "Reply"),
          ],
        }),
      );
      expect(JSON.parse(await nextMessage(nativeClient)).type).toBe("response.completed");
      expect(nativeInput).toEqual([
        { type: "reasoning", encrypted_content: "gAAAA-own" },
        message("user", "Reply"),
      ]);

      const routedClient = new WebSocket(url, { headers: agentHeaders });
      closeables.push(async () => routedClient.close());
      await opened(routedClient);
      routedClient.send(
        JSON.stringify({
          type: "response.create",
          model: "glm-5.3-flash",
          client_metadata: {
            thread_id: "custom-child",
            "x-codex-parent-thread-id": "native-root",
          },
          input: [
            { type: "reasoning", encrypted_content: "gAAAA-foreign" },
            message("user", "Reply"),
            {
              type: "agent_message",
              author: "/root",
              recipient: "/root/custom_child",
              content: [{ type: "input_text", text: "Message Type: NEW_TASK\nPayload:\nReply" }],
            },
            { type: "reasoning", summary: [{ text: "Own summary" }] },
          ],
        }),
      );
      expect(JSON.parse(await nextMessage(routedClient)).type).toBe("response.completed");
      expect((routedInput as { type: string }[]).map((item) => item.type)).toEqual([
        "message",
        "message",
        "reasoning",
      ]);
      expect(JSON.stringify(routedInput)).not.toContain("gAAAA-foreign");
    } finally {
      if (previous === undefined) delete process.env.ACT_TEST_ROUTE_KEY;
      else process.env.ACT_TEST_ROUTE_KEY = previous;
    }
  });

  it("forwards and records WebSocket frames in both directions", async () => {
    const upstream = await startWebSocketServer((socket, request) => {
      expect(request.url).toBe("/backend-api/codex/responses");
      expect(request.headers.authorization).toBe("Bearer oauth-secret");
      expect(request.headers["chatgpt-account-id"]).toBe("workspace-123");

      socket.on("message", (message, isBinary) => {
        expect(isBinary).toBe(false);
        expect(rawDataText(message)).toBe('{"type":"response.create","generate":false}');
        socket.send('{"type":"response.created","response":{"id":"resp_1"}}');
      });
    });
    const captures = new MemoryCaptureSink();
    const proxy = await startProxy(upstream.origin, captures);
    const client = new WebSocket(
      proxy.origin.replace("http://", "ws://") + "/backend-api/codex/responses",
      {
        headers: {
          authorization: "Bearer oauth-secret",
          "chatgpt-account-id": "workspace-123",
        },
      },
    );
    closeables.push(async () => client.close());

    await opened(client);
    client.send('{"type":"response.create","generate":false}');
    expect(await nextMessage(client)).toBe(
      '{"type":"response.created","response":{"id":"resp_1"}}',
    );
    await eventually(() => expect(captures.events).toHaveLength(2));
    expect(captures.events).toMatchObject([
      {
        transport: "websocket",
        direction: "client_to_upstream",
        payload: '{"type":"response.create","generate":false}',
      },
      {
        transport: "websocket",
        direction: "upstream_to_client",
        payload: '{"type":"response.created","response":{"id":"resp_1"}}',
        origin: { kind: "chatgpt-websocket", url: expect.stringMatching(/^ws:\/\//) },
      },
    ]);
  });

  it("rewrites a WebSocket response.create and records original and effective payloads", async () => {
    const upstream = await startWebSocketServer((socket) => {
      socket.on("message", (message) => {
        expect(JSON.parse(rawDataText(message))).toMatchObject({
          input: [{ content: [{ text: "Reply with exactly: transformed-smoke" }] }],
        });
        socket.send('{"type":"response.completed","response":{"id":"resp_1"}}');
      });
    });
    const captures = new MemoryCaptureSink();
    const transformations: Transformation[] = [
      {
        id: "smoke",
        name: "Smoke rewrite",
        enabled: true,
        scope: { harnesses: ["tui"] },
        target: { field: "message_text" },
        operation: {
          type: "replace",
          find: "Reply with exactly: original-smoke",
          replacement: "Reply with exactly: transformed-smoke",
        },
      },
    ];
    const proxy = await startProxy(upstream.origin, captures, transformations);
    const client = new WebSocket(
      proxy.origin.replace("http://", "ws://") + "/backend-api/codex/responses",
      {
        headers: {
          originator: "codex-tui",
          "user-agent": "codex-tui/0.146.0 (Mac OS 26.5.0; arm64)",
        },
      },
    );
    closeables.push(async () => client.close());
    await opened(client);
    client.send(
      JSON.stringify({
        type: "response.create",
        model: "gpt-5.6-luna",
        input: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Reply with exactly: original-smoke" }],
          },
        ],
      }),
    );
    await nextMessage(client);
    await eventually(() => expect(captures.events).toHaveLength(2));

    expect(captures.events[0]).toMatchObject({
      harness: { kind: "tui", version: "0.146.0" },
      transformationExecutions: [{ transformationId: "smoke", status: "hit", matchCount: 1 }],
    });
    expect(captures.events[0]).toMatchObject({
      payload: expect.stringContaining("original-smoke"),
      effectivePayload: expect.stringContaining("transformed-smoke"),
    });
  });

  it("switches to metadata-only capture after the first real user message", async () => {
    let requestCount = 0;
    const upstream = await startWebSocketServer((socket) => {
      socket.on("message", (message) => {
        requestCount += 1;
        const payload = JSON.parse(rawDataText(message)) as Record<string, unknown>;
        if (requestCount === 3) {
          expect(JSON.stringify(payload)).toContain("later-effective");
          expect(JSON.stringify(payload)).not.toContain("later-original");
        }
        socket.send(
          JSON.stringify({
            type: "response.completed",
            response: { id: `resp_${requestCount}`, usage: { input_tokens: requestCount } },
          }),
        );
      });
    });
    const captures = new MemoryCaptureSink();
    const transformations: Transformation[] = [
      {
        id: "later-rewrite",
        name: "Later rewrite",
        enabled: true,
        scope: {},
        target: { field: "message_text" },
        operation: {
          type: "replace",
          find: "later-original",
          replacement: "later-effective",
        },
      },
    ];
    const proxy = await startProxy(upstream.origin, captures, transformations);
    const client = new WebSocket(
      proxy.origin.replace("http://", "ws://") + "/backend-api/codex/responses",
    );
    closeables.push(async () => client.close());
    await opened(client);

    client.send(
      JSON.stringify({
        type: "response.create",
        generate: false,
        input: [message("developer", "prewarm")],
      }),
    );
    await nextMessage(client);
    client.send(
      JSON.stringify({
        type: "response.create",
        input: [message("developer", "initial context"), message("user", "first-real-user")],
      }),
    );
    await nextMessage(client);
    client.send(
      JSON.stringify({
        type: "response.create",
        previous_response_id: "resp_2",
        input: [
          message("developer", "later developer injection"),
          message("user", "<environment_context>\nlater harness context"),
          message("user", "later-original"),
        ],
      }),
    );
    await nextMessage(client);
    await eventually(() => expect(captures.events).toHaveLength(6));

    const clientEvents = captures.events.filter(
      (event) => event.direction === "client_to_upstream",
    );
    expect(clientEvents[0]).toMatchObject({ payloadMode: "full" });
    expect(clientEvents[1]).toMatchObject({ payloadMode: "full" });
    expect(clientEvents[2]).toMatchObject({
      payloadMode: "metadata",
      requestSummary: {
        type: "response.create",
        messages: [
          { role: "developer", characters: 25 },
          { role: "user", classificationId: "segment:environment" },
          { role: "user", characters: 14 },
        ],
      },
      transformationChanged: true,
      transformationExecutions: [
        { transformationId: "later-rewrite", status: "hit", matchCount: 1 },
      ],
    });
    expect(clientEvents[2]).not.toHaveProperty("payload");
    expect(JSON.stringify(clientEvents[2])).not.toContain("later-original");

    const responseEvents = captures.events.filter(
      (event) => event.direction === "upstream_to_client",
    );
    expect(responseEvents[2]).toMatchObject({
      payloadMode: "metadata",
      responseSummary: { type: "response.completed", id: "resp_3" },
    });
    expect(responseEvents[2]).not.toHaveProperty("payload");
  });

  it("fails closed before an HTTP request reaches upstream when capture fails", async () => {
    let upstreamRequests = 0;
    const upstream = await startHttpServer((_request, response) => {
      upstreamRequests += 1;
      response.end();
    });
    const proxy = await startProxy(upstream.origin, {
      record: async () => {
        throw new Error("disk full");
      },
    });

    const response = await fetch(`${proxy.origin}/backend-api/codex/responses`, {
      method: "POST",
      body: "{}",
    });

    expect(response.status).toBe(500);
    expect(await response.text()).toContain("capture failed");
    expect(upstreamRequests).toBe(0);
  });

  it("retains only Cloudflare infrastructure cookies for upstream requests", async () => {
    const seenCookies: Array<string | undefined> = [];
    const upstream = await startHttpServer((request, response) => {
      seenCookies.push(request.headers.cookie);
      response.setHeader("set-cookie", [
        "__cf_bm=affinity; Path=/; Secure; HttpOnly",
        "session=must-not-be-retained; Path=/; Secure",
      ]);
      response.end("ok");
    });
    const proxy = await startProxy(upstream.origin, new MemoryCaptureSink());

    await fetch(`${proxy.origin}/backend-api/codex/responses`, {
      method: "POST",
      body: "first",
    });
    await fetch(`${proxy.origin}/backend-api/codex/responses`, {
      method: "POST",
      body: "second",
    });

    expect(seenCookies).toEqual([undefined, "__cf_bm=affinity"]);
  });
});

describe("model routing and config bundle override", () => {
  it("serves an enabled config bundle override without hitting upstream", async () => {
    let upstreamRequests = 0;
    const upstream = await startHttpServer((_request, response) => {
      upstreamRequests += 1;
      response.end("upstream");
    });
    const captures = new MemoryCaptureSink();
    const proxy = await startRoutingProxy(upstream.origin, captures, {
      bundleOverride: { version: 1, enabled: true, bundle: { requirements_toml: null } },
    });

    const response = await fetch(`${proxy.origin}/backend-api/wham/config/bundle`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ requirements_toml: null });
    expect(upstreamRequests).toBe(0);
    expect(captures.events).toMatchObject([
      { transport: "http", routing: { action: "bundle-override" } },
    ]);
  });

  it("forwards config bundle requests when the override is disabled", async () => {
    const upstream = await startHttpServer((_request, response) => {
      response.end("upstream-bundle");
    });
    const proxy = await startRoutingProxy(upstream.origin, new MemoryCaptureSink(), {
      bundleOverride: { version: 1, enabled: false, bundle: null },
    });

    const response = await fetch(`${proxy.origin}/backend-api/wham/config/bundle`);

    expect(await response.text()).toBe("upstream-bundle");
  });

  it("routes a Responses request to the route upstream with swapped credentials", async () => {
    process.env.ACT_TEST_ROUTE_KEY = "local-api-key";
    try {
      const chatgpt = await startHttpServer((_request, response) => {
        response.end("chatgpt");
      });
      const routed = await startHttpServer(async (request, response) => {
        expect(request.url).toBe("/v1/responses?trace=1");
        expect(request.headers.authorization).toBe("Bearer local-api-key");
        expect(request.headers["chatgpt-account-id"]).toBeUndefined();
        expect(request.headers.cookie).toBeUndefined();
        const body = await readBody(request);
        expect(JSON.parse(body.toString())).toEqual({
          model: "moonshot-kimi-k3",
          input: "hello",
        });
        response.end("routed");
      });
      const captures = new MemoryCaptureSink();
      const proxy = await startRoutingProxy(chatgpt.origin, captures, {
        routes: [testRoute(routed.origin)],
      });

      const response = await fetch(`${proxy.origin}/backend-api/codex/responses?trace=1`, {
        method: "POST",
        headers: {
          authorization: "Bearer oauth-secret",
          "chatgpt-account-id": "workspace-123",
          "content-type": "application/json",
          cookie: "session=secret",
        },
        body: JSON.stringify({
          model: "kimi-k3",
          input: "hello",
          access_programs: { cyber: "standard" },
        }),
      });

      expect(response.status).toBe(200);
      expect(await response.text()).toBe("routed");
      expect(captures.events[0]).toMatchObject({
        routing: {
          action: "routed",
          routeSlugs: ["kimi-k3"],
          upstream: routed.origin,
          requestedModel: "kimi-k3",
          upstreamModel: "moonshot-kimi-k3",
        },
        origin: {
          kind: "gateway-http",
          url: `${routed.origin}/v1/responses?trace=1`,
        },
      });
    } finally {
      delete process.env.ACT_TEST_ROUTE_KEY;
    }
  });

  it("forwards access_programs on a routed HTTP request when the route opts in", async () => {
    process.env.ACT_TEST_ROUTE_KEY = "local-api-key";
    try {
      const routed = await startHttpServer(async (request, response) => {
        const body = await readBody(request);
        expect(JSON.parse(body.toString())).toEqual({
          model: "moonshot-kimi-k3",
          input: "hello",
          access_programs: { cyber: "standard" },
        });
        response.end("routed");
      });
      const proxy = await startRoutingProxy("http://127.0.0.1:1", new MemoryCaptureSink(), {
        routes: [{ ...testRoute(routed.origin), forwardAccessPrograms: true }],
      });

      const response = await fetch(`${proxy.origin}/backend-api/codex/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "kimi-k3",
          input: "hello",
          access_programs: { cyber: "standard" },
        }),
      });

      expect(response.status).toBe(200);
      expect(await response.text()).toBe("routed");
    } finally {
      delete process.env.ACT_TEST_ROUTE_KEY;
    }
  });

  it("stores responses for a routed HTTP request when the route opts in", async () => {
    process.env.ACT_TEST_ROUTE_KEY = "local-api-key";
    try {
      const routed = await startHttpServer(async (request, response) => {
        expect(JSON.parse((await readBody(request)).toString())).toEqual({
          model: "moonshot-kimi-k3",
          input: "hello",
          store: true,
          tools: [{ type: "function", name: "exec_command" }],
        });
        response.end("routed");
      });
      const proxy = await startRoutingProxy("http://127.0.0.1:1", new MemoryCaptureSink(), {
        routes: [
          {
            ...testRoute(routed.origin),
            bridgeResponseState: "stored",
          },
        ],
      });

      const response = await fetch(`${proxy.origin}/backend-api/codex/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "kimi-k3",
          input: "hello",
          store: false,
          tools: [{ type: "function", name: "exec_command" }],
        }),
      });

      expect(response.status).toBe(200);
      expect(await response.text()).toBe("routed");
    } finally {
      delete process.env.ACT_TEST_ROUTE_KEY;
    }
  });

  it("decompresses a zstd Responses body before routing it to the gateway", async () => {
    process.env.ACT_TEST_ROUTE_KEY = "local-api-key";
    try {
      let chatgptHits = 0;
      const chatgpt = await startHttpServer((_request, response) => {
        chatgptHits += 1;
        response.end("chatgpt");
      });
      const routed = await startHttpServer(async (request, response) => {
        expect(request.headers["content-encoding"]).toBeUndefined();
        const body = await readBody(request);
        expect(JSON.parse(body.toString())).toMatchObject({
          model: "moonshot-kimi-k3",
          input: "hello",
        });
        response.end("routed");
      });
      const captures = new MemoryCaptureSink();
      const proxy = await startRoutingProxy(chatgpt.origin, captures, {
        routes: [testRoute(routed.origin)],
      });
      const payload = JSON.stringify({ model: "kimi-k3", input: "hello" });
      const compressed = Buffer.from(await Bun.zstdCompress(payload));

      const response = await fetch(`${proxy.origin}/backend-api/codex/responses`, {
        method: "POST",
        headers: {
          authorization: "Bearer oauth-secret",
          "content-type": "application/json",
          "content-encoding": "zstd",
        },
        body: compressed,
      });

      expect(response.status).toBe(200);
      expect(await response.text()).toBe("routed");
      expect(chatgptHits).toBe(0);
      expect(captures.events[0]).toMatchObject({
        routing: {
          action: "routed",
          requestedModel: "kimi-k3",
          upstreamModel: "moonshot-kimi-k3",
        },
        origin: { kind: "gateway-http" },
      });
    } finally {
      delete process.env.ACT_TEST_ROUTE_KEY;
    }
  });

  it("keeps unmatched models on the default upstream", async () => {
    const chatgpt = await startHttpServer((request, response) => {
      expect(request.headers.authorization).toBe("Bearer oauth-secret");
      response.end("chatgpt");
    });
    const proxy = await startRoutingProxy(chatgpt.origin, new MemoryCaptureSink(), {
      routes: [testRoute("http://127.0.0.1:1")],
    });

    const response = await fetch(`${proxy.origin}/backend-api/codex/responses`, {
      method: "POST",
      headers: { authorization: "Bearer oauth-secret", "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-5.6", input: "hello" }),
    });

    expect(await response.text()).toBe("chatgpt");
  });

  it("fails a routed request with 502 when the route credential env is unset", async () => {
    delete process.env.ACT_TEST_ROUTE_KEY;
    const chatgpt = await startHttpServer((_request, response) => {
      response.end("chatgpt");
    });
    const proxy = await startRoutingProxy(chatgpt.origin, new MemoryCaptureSink(), {
      routes: [testRoute("http://127.0.0.1:1")],
    });

    const response = await fetch(`${proxy.origin}/backend-api/codex/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "kimi-k3", input: "hello" }),
    });

    expect(response.status).toBe(502);
    expect(await response.text()).toContain("ACT_TEST_ROUTE_KEY");
  });

  it("prepends routed models to the upstream model list", async () => {
    const chatgpt = await startHttpServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          models: [
            {
              slug: "gpt-5.6-terra",
              context_window: 272000,
              display_name: "GPT-5.6 Terra",
              upgrade: { model: "gpt-5.7" },
            },
          ],
        }),
      );
    });
    const captures = new MemoryCaptureSink();
    const proxy = await startRoutingProxy(chatgpt.origin, captures, {
      routes: [testRoute("http://127.0.0.1:1")],
    });

    const response = await fetch(`${proxy.origin}/backend-api/codex/models`);

    expect(response.status).toBe(200);
    const body = (await response.json()) as { models: Array<Record<string, unknown>> };
    expect(body.models.map((model) => model.slug)).toEqual(["kimi-k3", "gpt-5.6-terra"]);
    expect(body.models[0]).toMatchObject({
      slug: "kimi-k3",
      display_name: "Kimi K3",
      context_window: 272000,
    });
    expect(body.models[0]).not.toHaveProperty("upgrade");
    expect(captures.events[0]).toMatchObject({
      routing: { action: "models-advertised", routeSlugs: ["kimi-k3"] },
    });
  });

  it("reorders /models only when routed agents and native spawn preference are both enabled", async () => {
    const chatgpt = await startHttpServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          models: [{ slug: "gpt-5.6-terra", priority: 2, visibility: "list" }],
        }),
      );
    });
    const route = { ...testRoute("http://127.0.0.1:1"), handoffClass: "plaintext" as const };
    const catalog = async (enabled: boolean, prefer: boolean) => {
      const proxy = await startRoutingProxy(chatgpt.origin, new MemoryCaptureSink(), {
        routes: [route],
        proxyConfigSource: {
          get: () => ({
            version: 1,
            appsAuthRelay: true,
            search_broker: { route: "gpt-6-luna" },
            routed_agents: { enabled, prefer_native_spawn_models: prefer },
          }),
          subscribe: () => () => {},
        },
      });
      const response = await fetch(`${proxy.origin}/backend-api/codex/models`);
      expect(response.status).toBe(200);
      return (
        (await response.json()) as { models: Array<{ slug: string; priority: number }> }
      ).models.map((model) => [model.slug, model.priority]);
    };
    const original = [
      ["kimi-k3", 1],
      ["gpt-5.6-terra", 2],
    ];
    expect(await catalog(false, true)).toEqual(original);
    expect(await catalog(true, false)).toEqual(original);
    expect(await catalog(true, true)).toEqual([
      ["gpt-5.6-terra", 1],
      ["kimi-k3", 2],
    ]);
  });

  it("advertises a route templated on a fixture-only model", async () => {
    const chatgpt = await startHttpServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ models: [{ slug: "gpt-5.6-terra" }] }));
    });
    const astraRoute: ModelRoute = {
      ...testRoute("http://127.0.0.1:1"),
      model: {
        description: "Astra via another upstream",
        displayName: "My Astra",
        overrides: {},
        priority: 1,
        slug: "my-astra",
        templateSlug: "gpt-6-astra",
        templateReplacements: [],
      },
    };
    const proxy = await startRoutingProxy(chatgpt.origin, new MemoryCaptureSink(), {
      routes: [astraRoute],
    });

    const response = await fetch(`${proxy.origin}/backend-api/codex/models`);

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      models: Array<{ slug: string; model_messages?: Record<string, unknown> }>;
    };
    expect(body.models.map((model) => model.slug)).toEqual(["my-astra", "gpt-5.6-terra"]);
    // Cloned from the baked-in gpt-6-astra fixture, including its model_messages.
    expect(body.models[0]?.model_messages).toHaveProperty("persistent_instructions");
    expect(body.models[0]?.model_messages).toHaveProperty("guardian_v2");
  });

  it("serves the fixture version of a pinned upstream model", async () => {
    const chatgpt = await startHttpServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          models: [{ slug: "gpt-5.6-terra", display_name: "GPT-5.6 Terra (upstream)" }],
        }),
      );
    });
    const fixtureModels: ModelDefinition[] = [
      { slug: "gpt-5.6-terra", display_name: "GPT-5.6 Terra (fixture)" },
    ];
    const pinned = await startRoutingProxy(chatgpt.origin, new MemoryCaptureSink(), {
      fixtureModels,
      fixturePins: ["gpt-5.6-terra"],
    });

    const pinnedResponse = await fetch(`${pinned.origin}/backend-api/codex/models`);
    expect(pinnedResponse.status).toBe(200);
    const pinnedBody = (await pinnedResponse.json()) as {
      models: Array<{ display_name: string }>;
    };
    expect(pinnedBody.models[0]?.display_name).toBe("GPT-5.6 Terra (fixture)");

    const unpinned = await startRoutingProxy(chatgpt.origin, new MemoryCaptureSink(), {
      fixtureModels,
    });
    const unpinnedResponse = await fetch(`${unpinned.origin}/backend-api/codex/models`);
    const unpinnedBody = (await unpinnedResponse.json()) as {
      models: Array<{ display_name: string }>;
    };
    expect(unpinnedBody.models[0]?.display_name).toBe("GPT-5.6 Terra (upstream)");
  });

  it("retries flex on 429 and fails over to the regular model", async () => {
    process.env.OPENAI_API_KEY = "test-gateway-key";
    const seen: string[] = [];
    let flexFailures = 0;
    const gateway = await startHttpServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => (body += chunk));
      request.on("end", () => {
        const model = (JSON.parse(body) as { model: string }).model;
        seen.push(model);
        response.setHeader("content-type", "application/json");
        if (model === "openai.gpt-6-astra-flex" && flexFailures < 5) {
          flexFailures += 1;
          response.statusCode = 429;
          response.end(JSON.stringify({ error: { message: "resource unavailable" } }));
          return;
        }
        response.end(JSON.stringify({ model, ok: true }));
      });
    });
    const route = modelRouteFromConfig({
      authorization_env: "OPENAI_API_KEY",
      model: {
        description: "GPT-6 Astra via the AI gateway",
        display_name: "GPT-6 Astra",
        priority: 1,
        slug: "gpt-6-astra",
        template_slug: "gpt-6-astra",
      },
      upstream: `${gateway.origin}/openai/v1`,
      transport: "http",
      targets: [
        { upstream_model: "openai.gpt-6-astra-flex", attempts: 3 },
        { upstream_model: "openai.gpt-6-astra" },
      ],
      retry: { on_status: [429], backoff_ms: [0], breaker: { failures: 1, cooldown_ms: 300_000 } },
    });
    const captures = new MemoryCaptureSink();
    const liveRequests = new LiveRequestStore();
    const proxy = await startRoutingProxy(gateway.origin, captures, {
      routes: [route],
      liveRequests,
    });

    const first = await fetch(`${proxy.origin}/backend-api/codex/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-6-astra", input: "hello" }),
    });

    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ model: "openai.gpt-6-astra", ok: true });
    expect(seen).toEqual([
      "openai.gpt-6-astra-flex",
      "openai.gpt-6-astra-flex",
      "openai.gpt-6-astra-flex",
      "openai.gpt-6-astra",
    ]);
    expect(captures.events[0]?.routing).toMatchObject({
      action: "routed",
      requestedModel: "gpt-6-astra",
      upstreamModel: "openai.gpt-6-astra",
      attempts: [
        { upstreamModel: "openai.gpt-6-astra-flex", outcome: "retry", status: 429 },
        { upstreamModel: "openai.gpt-6-astra-flex", outcome: "retry", status: 429 },
        { upstreamModel: "openai.gpt-6-astra-flex", outcome: "retry", status: 429 },
        { upstreamModel: "openai.gpt-6-astra", outcome: "served", status: 200 },
      ],
    });
    expect(liveRequests.snapshot().recent[0]).toMatchObject({
      state: "completed",
      requestedModel: "gpt-6-astra",
      targetModel: "openai.gpt-6-astra",
      upstream: expect.stringContaining("/openai/v1/responses"),
    });
    expect(liveRequests.snapshot().recent[0]?.events.map((event) => event.state)).toEqual(
      expect.arrayContaining(["retrying", "falling-back", "streaming", "completed"]),
    );

    // The flex breaker opened after the exhausted episode: the next request
    // goes straight to the regular model.
    const second = await fetch(`${proxy.origin}/backend-api/codex/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-6-astra", input: "again" }),
    });

    expect(second.status).toBe(200);
    expect(seen).toEqual([
      "openai.gpt-6-astra-flex",
      "openai.gpt-6-astra-flex",
      "openai.gpt-6-astra-flex",
      "openai.gpt-6-astra",
      "openai.gpt-6-astra",
    ]);
    expect(captures.events[1]?.routing?.attempts).toEqual([
      { upstreamModel: "openai.gpt-6-astra-flex", outcome: "breaker-open" },
      {
        upstreamModel: "openai.gpt-6-astra",
        outcome: "served",
        status: 200,
        durationMs: expect.any(Number),
      },
    ]);
    delete process.env.OPENAI_API_KEY;
  });

  it("observes the upstream models response and applies adjustments", async () => {
    const chatgpt = await startHttpServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          models: [
            {
              slug: "gpt-5.6-terra",
              display_name: "GPT-5.6 Terra",
              priority: 1,
              context_window: 272000,
              model_messages: {
                instructions_template: "base instructions",
                token_budget: { enabled: false, reminder_threshold_tokens: 6144 },
              },
            },
          ],
        }),
      );
    });
    const cache = new MemoryUpstreamCache();
    const proxy = await startRoutingProxy(chatgpt.origin, new MemoryCaptureSink(), {
      adjustments: [
        {
          slug: "gpt-5.6-terra",
          overrides: {
            context_window: 1_000_000,
            model_messages: { token_budget: { reminder_threshold_tokens: 8192 } },
          },
        },
      ],
      upstreamCache: cache,
    });

    const response = await fetch(`${proxy.origin}/backend-api/codex/models`);

    expect(response.status).toBe(200);
    const body = (await response.json()) as { models: Array<Record<string, unknown>> };
    expect(body.models[0]).toMatchObject({
      slug: "gpt-5.6-terra",
      context_window: 1_000_000,
      model_messages: {
        instructions_template: "base instructions",
        token_budget: { enabled: false, reminder_threshold_tokens: 8192 },
      },
    });
    // The cache holds the original, unadjusted upstream body.
    expect(cache.state.models).toMatchObject({
      body: { models: [{ slug: "gpt-5.6-terra", context_window: 272000 }] },
    });
  });

  it("applies message transformations to upstream model instruction strings", async () => {
    const chatgpt = await startHttpServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          models: [
            {
              slug: "gpt-5.6-terra",
              model_messages: {
                instructions_template: "You are Codex, an agent based on GPT-5. Be helpful.",
                token_budget: { guidance_message: "Use notes to checkpoint." },
              },
            },
          ],
        }),
      );
    });
    const proxy = await startRoutingProxy(chatgpt.origin, new MemoryCaptureSink(), {
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
    });

    const response = await fetch(`${proxy.origin}/backend-api/codex/models`);

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      models: Array<{ model_messages: Record<string, unknown> }>;
    };
    expect(body.models[0]?.model_messages).toMatchObject({
      instructions_template: "You are Codex, an agent based on GPT-5. Be terse.",
      token_budget: { guidance_message: "Use notes to checkpoint." },
    });
  });

  it("passes the models response through untouched when no transformation matches", async () => {
    const chatgpt = await startHttpServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.setHeader("etag", '"upstream-etag"');
      response.end(JSON.stringify({ models: [{ slug: "gpt-5.6-terra" }] }));
    });
    const proxy = await startRoutingProxy(chatgpt.origin, new MemoryCaptureSink(), {
      transformations: [
        {
          id: "trim-base",
          name: "Trim base",
          enabled: true,
          scope: {},
          target: { field: "message_text", identifier: "segment:codex_base" },
          operation: { type: "delete_part" },
        },
      ],
    });

    const response = await fetch(`${proxy.origin}/backend-api/codex/models`);

    expect(response.status).toBe(200);
    expect(response.headers.get("etag")).toBe('"upstream-etag"');
    expect(await response.json()).toEqual({ models: [{ slug: "gpt-5.6-terra" }] });
  });

  it("observes the upstream config bundle on passthrough", async () => {
    const chatgpt = await startHttpServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ requirements_toml: "managed = true" }));
    });
    const cache = new MemoryUpstreamCache();
    const proxy = await startRoutingProxy(chatgpt.origin, new MemoryCaptureSink(), {
      upstreamCache: cache,
    });

    const response = await fetch(`${proxy.origin}/backend-api/wham/config/bundle`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ requirements_toml: "managed = true" });
    expect(cache.state.configBundle).toMatchObject({
      body: { requirements_toml: "managed = true" },
    });
  });

  it("observes the upstream bundle while answering with the override", async () => {
    const chatgpt = await startHttpServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ requirements_toml: "managed = true" }));
    });
    const cache = new MemoryUpstreamCache();
    const proxy = await startRoutingProxy(chatgpt.origin, new MemoryCaptureSink(), {
      bundleOverride: { version: 1, enabled: true, bundle: { requirements_toml: null } },
      upstreamCache: cache,
    });

    const response = await fetch(`${proxy.origin}/backend-api/wham/config/bundle`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ requirements_toml: null });
    await eventually(() =>
      expect(cache.state.configBundle).toMatchObject({
        body: { requirements_toml: "managed = true" },
      }),
    );
  });

  it("routes a WebSocket response.create by the first message model", async () => {
    process.env.ACT_TEST_ROUTE_KEY = "local-api-key";
    try {
      const chatgpt = await startWebSocketServer((socket) => {
        socket.on("message", () => socket.send("chatgpt"));
      });
      const routed = await startWebSocketServer((socket, request) => {
        expect(request.url).toBe("/v1/responses");
        expect(request.headers.authorization).toBe("Bearer local-api-key");
        expect(request.headers["chatgpt-account-id"]).toBeUndefined();
        socket.on("message", (message) => {
          expect(JSON.parse(rawDataText(message))).toMatchObject({ model: "moonshot-kimi-k3" });
          socket.send("routed");
        });
      });
      const captures = new MemoryCaptureSink();
      const proxy = await startRoutingProxy(chatgpt.origin, captures, {
        routes: [testRoute(routed.origin)],
      });
      const client = new WebSocket(
        proxy.origin.replace("http://", "ws://") + "/backend-api/codex/responses",
        {
          headers: {
            authorization: "Bearer oauth-secret",
            "chatgpt-account-id": "workspace-123",
          },
        },
      );
      closeables.push(async () => client.close());
      await opened(client);

      client.send(JSON.stringify({ type: "response.create", model: "kimi-k3", input: [] }));

      expect(await nextMessage(client)).toBe("routed");
      await eventually(() => expect(captures.events.length).toBeGreaterThanOrEqual(1));
      expect(captures.events[0]).toMatchObject({
        direction: "client_to_upstream",
        routing: {
          action: "routed",
          routeSlugs: ["kimi-k3"],
          upstream: routed.origin,
          requestedModel: "kimi-k3",
          upstreamModel: "moonshot-kimi-k3",
        },
      });
    } finally {
      delete process.env.ACT_TEST_ROUTE_KEY;
    }
  });

  it("rejects a disallowed tool on a routed HTTP request before upstream delivery", async () => {
    process.env.ACT_TEST_ROUTE_KEY = "local-api-key";
    try {
      let deliveries = 0;
      const gateway = await startHttpServer((_request, response) => {
        deliveries += 1;
        response.end("unexpected");
      });
      const route = modelRouteFromConfig({
        ...routeConfigForTest(gateway.origin),
        transport: "http",
        tool_policy: { web_search: "reject" },
      });
      const proxy = await startRoutingProxy(gateway.origin, new MemoryCaptureSink(), {
        routes: [route],
      });

      const response = await fetch(`${proxy.origin}/backend-api/codex/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "kimi-k3",
          input: [],
          tools: [{ type: "web_search" }],
        }),
      });

      expect(response.status).toBe(400);
      expect(await response.text()).toContain(
        'model route "kimi-k3" rejects tool type "web_search"',
      );
      const choice = await fetch(`${proxy.origin}/backend-api/codex/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "kimi-k3", input: [], tool_choice: { type: "web_search" } }),
      });
      expect(choice.status).toBe(400);
      expect(await choice.text()).toContain('model route "kimi-k3" rejects tool type "web_search"');
      expect(deliveries).toBe(0);
    } finally {
      delete process.env.ACT_TEST_ROUTE_KEY;
    }
  });

  it("passes native web search through the WebSocket bridge and matches its stored replay", async () => {
    process.env.ACT_TEST_ROUTE_KEY = "local-api-key";
    try {
      const seen: Record<string, unknown>[] = [];
      const search = {
        type: "web_search_call",
        id: "ws_1",
        status: "completed",
        action: { type: "search", query: "NASA Mars facts" },
      };
      const source = {
        type: "tool_output",
        tool_call_id: "provider_1",
        output:
          '{"results":[{"url":"https://science.nasa.gov/mars/facts/","title":"Mars: Facts"}]}',
      };
      const answer = {
        type: "message",
        id: "msg_1",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: "Mars has two moons: https://science.nasa.gov/mars/facts/",
            annotations: [],
          },
        ],
      };
      const gateway = await startHttpServer(async (request, response) => {
        const payload = JSON.parse((await readBody(request)).toString()) as Record<string, unknown>;
        seen.push(payload);
        const id = `resp_${seen.length}`;
        response.setHeader("content-type", "text/event-stream");
        response.write(
          `data: ${JSON.stringify({ type: "response.created", response: { id } })}\n\n`,
        );
        if (seen.length === 1) {
          response.write(
            `data: ${JSON.stringify({ type: "response.output_item.done", item: search })}\n\n`,
          );
          response.write(
            `data: ${JSON.stringify({ type: "response.output_item.done", item: answer })}\n\n`,
          );
        }
        response.end(
          `data: ${JSON.stringify({ type: "response.completed", response: { id, output: seen.length === 1 ? [search, source, answer] : [] } })}\n\n`,
        );
      });
      const route = modelRouteFromConfig({
        ...routeConfigForTest(gateway.origin),
        transport: "http",
        bridge_response_state: "stored",
        tool_policy: { custom: "translate", web_search: "pass" },
      });
      const proxy = await startRoutingProxy("http://127.0.0.1:1", new MemoryCaptureSink(), {
        routes: [route],
      });
      const identity = {
        authorization: "Bearer oauth-secret",
        "chatgpt-account-id": "account-1",
        "session-id": "session-1",
        "thread-id": "thread-1",
      };
      const user = message("user", "Search NASA");
      const webTool = { type: "web_search", external_web_access: true, indexed_web_access: true };
      const client = new WebSocket(
        proxy.origin.replace("http://", "ws://") + "/backend-api/codex/responses",
        { headers: identity },
      );
      closeables.push(async () => client.close());
      await opened(client);
      const received: Record<string, unknown>[] = [];
      client.on("message", (raw) => received.push(JSON.parse(rawDataText(raw))));
      client.send(
        JSON.stringify({
          type: "response.create",
          model: "kimi-k3",
          input: [user],
          tools: [webTool],
          tool_choice: { type: "web_search" },
        }),
      );
      await eventually(() =>
        expect(received.some((event) => event.type === "response.completed")).toBe(true),
      );
      expect(seen[0]).toMatchObject({
        tools: [webTool],
        tool_choice: { type: "web_search" },
      });
      expect(received.find((event) => event.type === "response.output_item.done")?.item).toEqual(
        search,
      );
      const completed = received.find((event) => event.type === "response.completed")?.response as {
        output: unknown[];
      };
      expect(completed.output).toEqual([search, source, answer]);

      const followup = message("user", "Thanks");
      const next = await fetch(`${proxy.origin}/backend-api/codex/responses`, {
        method: "POST",
        headers: { ...identity, "content-type": "application/json" },
        body: JSON.stringify({
          model: "kimi-k3",
          input: [user, search, answer, followup],
          tools: [webTool],
          stream: true,
        }),
      });
      expect(next.status).toBe(200);
      await next.text();
      expect(seen[1]).toMatchObject({
        previous_response_id: "resp_1",
        input: [followup],
        tools: [webTool],
      });
    } finally {
      delete process.env.ACT_TEST_ROUTE_KEY;
    }
  });

  it("omits legacy-disallowed tools on HTTP and records each omission", async () => {
    process.env.ACT_TEST_ROUTE_KEY = "local-api-key";
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const seen: Record<string, unknown>[] = [];
      const gateway = await startHttpServer(async (request, response) => {
        seen.push(JSON.parse((await readBody(request)).toString()) as Record<string, unknown>);
        response.end("routed");
      });
      const config = routeConfigForTest(gateway.origin);
      const route = modelRouteFromConfig({
        ...config,
        model: { ...config.model, slug: "legacy-http" },
        transport: "http",
        allowed_tool_types: ["function"],
      });
      const captures = new MemoryCaptureSink();
      const liveRequests = new LiveRequestStore();
      const proxy = await startRoutingProxy(gateway.origin, captures, {
        routes: [route],
        liveRequests,
      });
      const payload = {
        model: "legacy-http",
        input: [],
        tools: [
          { type: "function", name: "read" },
          { type: "namespace", name: "mcp", tools: [{ type: "function", name: "search" }] },
          { type: "web_search" },
          { type: "future_tool", name: "future" },
        ],
        tool_choice: { type: "web_search" },
      };

      for (let index = 0; index < 3; index += 1) {
        const response = await fetch(`${proxy.origin}/backend-api/codex/responses`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(
            index === 0
              ? payload
              : { ...payload, type: "response.create", input: [message("user", "hi")] },
          ),
        });
        expect(response.status).toBe(200);
        expect(await response.text()).toBe("routed");
      }

      expect(seen).toHaveLength(3);
      expect(seen[0]).toMatchObject({ tools: [{ type: "function", name: "read" }] });
      expect(seen[0]).not.toHaveProperty("tool_choice");
      const requests = captures.events.filter((event) => event.direction === "client_to_upstream");
      expect(requests[0]?.routing).toMatchObject({
        omittedToolTypes: ["namespace", "web_search", "future_tool"],
      });
      expect(requests[0]).toHaveProperty("effectivePayload");
      expect(requests[2]).toMatchObject({
        payloadMode: "metadata",
        routing: { omittedToolTypes: ["namespace", "web_search", "future_tool"] },
      });
      expect(liveRequests.snapshot().recent[0]?.events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            detail: "Omitted tool types: namespace, web_search, future_tool",
          }),
        ]),
      );
      expect(
        warning.mock.calls.filter(([message]) => String(message).includes('"legacy-http"')),
      ).toHaveLength(3);
    } finally {
      warning.mockRestore();
      delete process.env.ACT_TEST_ROUTE_KEY;
    }
  });

  it("passes a future tool type through a default Responses route", async () => {
    process.env.ACT_TEST_ROUTE_KEY = "local-api-key";
    try {
      let forwarded: Record<string, unknown> | undefined;
      const gateway = await startHttpServer(async (request, response) => {
        forwarded = JSON.parse((await readBody(request)).toString()) as Record<string, unknown>;
        response.end("routed");
      });
      const route = modelRouteFromConfig({
        ...routeConfigForTest(gateway.origin),
        transport: "http",
      });
      const proxy = await startRoutingProxy(gateway.origin, new MemoryCaptureSink(), {
        routes: [route],
      });

      const response = await fetch(`${proxy.origin}/backend-api/codex/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "kimi-k3",
          input: [],
          tools: [{ type: "future_tool", name: "future" }],
        }),
      });

      expect(response.status).toBe(200);
      expect(forwarded?.tools).toEqual([{ type: "future_tool", name: "future" }]);
    } finally {
      delete process.env.ACT_TEST_ROUTE_KEY;
    }
  });

  it("applies the policy to tools nested inside a namespace", async () => {
    process.env.ACT_TEST_ROUTE_KEY = "local-api-key";
    try {
      let deliveries = 0;
      const gateway = await startHttpServer((_request, response) => {
        deliveries += 1;
        response.end("unexpected");
      });
      const route = modelRouteFromConfig({
        ...routeConfigForTest(gateway.origin),
        transport: "http",
        tool_policy: { function: "reject" },
      });
      const proxy = await startRoutingProxy(gateway.origin, new MemoryCaptureSink(), {
        routes: [route],
      });

      const response = await fetch(`${proxy.origin}/backend-api/codex/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "kimi-k3",
          input: [],
          tools: [
            { type: "namespace", name: "tools", tools: [{ type: "function", name: "read" }] },
          ],
        }),
      });

      expect(response.status).toBe(400);
      expect(await response.text()).toContain('model route "kimi-k3" rejects tool type "function"');
      expect(deliveries).toBe(0);
    } finally {
      delete process.env.ACT_TEST_ROUTE_KEY;
    }
  });

  it("rejects a disallowed tool on the WebSocket-to-HTTP bridge", async () => {
    process.env.ACT_TEST_ROUTE_KEY = "local-api-key";
    try {
      let deliveries = 0;
      const gateway = await startHttpServer((_request, response) => {
        deliveries += 1;
        response.end("unexpected");
      });
      const route = modelRouteFromConfig({
        ...routeConfigForTest(gateway.origin),
        transport: "http",
        tool_policy: { web_search: "reject" },
      });
      const proxy = await startRoutingProxy(gateway.origin, new MemoryCaptureSink(), {
        routes: [route],
      });
      const client = new WebSocket(
        proxy.origin.replace("http://", "ws://") + "/backend-api/codex/responses",
      );
      closeables.push(async () => client.close());
      await opened(client);
      client.send(
        JSON.stringify({
          type: "response.create",
          model: "kimi-k3",
          input: [],
          tools: [{ type: "web_search" }],
        }),
      );

      expect(JSON.parse(await nextMessage(client))).toMatchObject({
        type: "error",
        status: 400,
        error: { message: 'model route "kimi-k3" rejects tool type "web_search"' },
      });
      client.send(
        JSON.stringify({
          type: "response.create",
          model: "kimi-k3",
          generate: false,
          input: [],
          tools: [{ type: "web_search" }],
        }),
      );
      expect(JSON.parse(await nextMessage(client))).toMatchObject({ type: "error", status: 400 });
      expect(deliveries).toBe(0);
    } finally {
      delete process.env.ACT_TEST_ROUTE_KEY;
    }
  });

  it("refuses encrypted child messages over HTTP and forwards readable ones with agent identity", async () => {
    process.env.ACT_TEST_ROUTE_KEY = "local-api-key";
    try {
      const forwarded: Record<string, unknown>[] = [];
      const gateway = await startHttpServer(async (request, response) => {
        forwarded.push(JSON.parse((await readBody(request)).toString()) as Record<string, unknown>);
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end('data: {"type":"response.completed","response":{"output":[]}}\n\n');
      });
      const route = modelRouteFromConfig({
        ...routeConfigForTest(gateway.origin),
        transport: "http",
        handoff_class: "plaintext",
      });
      const proxy = await startRoutingProxy(gateway.origin, new MemoryCaptureSink(), {
        routes: [route],
      });
      const agentMessage = {
        type: "agent_message",
        author: "/root",
        recipient: "/root/worker",
        content: [
          { type: "input_text", text: "Message Type: NEW_TASK\nPayload:\n" },
          { type: "encrypted_content", encrypted_content: "opaque" },
        ],
      };
      const encrypted = await fetch(`${proxy.origin}/backend-api/codex/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "kimi-k3", input: [agentMessage] }),
      });
      expect(encrypted.status).toBe(422);
      const encryptedError = await encrypted.text();
      expect(encryptedError).toContain(
        'model route "kimi-k3" cannot read encrypted V2 agent_message',
      );
      expect(encryptedError).toContain("routed_agents.enabled");
      expect(encryptedError).toContain("use routed_agents.spawn_agent for kimi-k3");
      expect(forwarded).toHaveLength(0);

      const readable = await fetch(`${proxy.origin}/backend-api/codex/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "kimi-k3",
          input: [
            {
              ...agentMessage,
              content: [{ type: "input_text", text: "Message Type: NEW_TASK\nPayload:\nDo it" }],
            },
          ],
        }),
      });
      expect(readable.status).toBe(200);
      expect(forwarded[0]?.input).toMatchObject([
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: expect.stringContaining("/root to /root/worker") }],
        },
      ]);
      expect(JSON.stringify(forwarded[0]?.input)).toContain("Do it");
    } finally {
      delete process.env.ACT_TEST_ROUTE_KEY;
    }
  });

  it("refuses encrypted child messages on the WebSocket-to-HTTP bridge", async () => {
    process.env.ACT_TEST_ROUTE_KEY = "local-api-key";
    try {
      let deliveries = 0;
      const gateway = await startHttpServer((_request, response) => {
        deliveries += 1;
        response.end("unexpected");
      });
      const route = modelRouteFromConfig({
        ...routeConfigForTest(gateway.origin),
        transport: "http",
        handoff_class: "plaintext",
      });
      const proxy = await startRoutingProxy(gateway.origin, new MemoryCaptureSink(), {
        routes: [route],
      });
      const client = new WebSocket(
        proxy.origin.replace("http://", "ws://") + "/backend-api/codex/responses",
      );
      closeables.push(async () => client.close());
      await opened(client);
      client.send(
        JSON.stringify({
          type: "response.create",
          model: "kimi-k3",
          input: [
            {
              type: "agent_message",
              author: "/root",
              recipient: "/root/worker",
              content: [
                { type: "input_text", text: "Message Type: NEW_TASK\nPayload:\n" },
                { type: "encrypted_content", encrypted_content: "opaque" },
              ],
            },
          ],
        }),
      );
      expect(JSON.parse(await nextMessage(client))).toMatchObject({
        type: "error",
        status: 422,
        error: {
          message: expect.stringContaining("use routed_agents.spawn_agent for kimi-k3"),
        },
      });
      expect(deliveries).toBe(0);
    } finally {
      delete process.env.ACT_TEST_ROUTE_KEY;
    }
  });

  it("forwards encrypted agent messages on an explicitly native-encrypted gateway route", async () => {
    process.env.ACT_TEST_ROUTE_KEY = "local-api-key";
    try {
      let forwarded: Record<string, unknown> | undefined;
      const gateway = await startHttpServer(async (request, response) => {
        forwarded = JSON.parse((await readBody(request)).toString()) as Record<string, unknown>;
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end('data: {"type":"response.completed","response":{"output":[]}}\n\n');
      });
      const route = modelRouteFromConfig({
        ...routeConfigForTest(gateway.origin),
        transport: "http",
        handoff_class: "native-encrypted",
      });
      const proxy = await startRoutingProxy(gateway.origin, new MemoryCaptureSink(), {
        routes: [route],
      });
      const encrypted = {
        type: "agent_message",
        author: "/root",
        recipient: "/root/worker",
        content: [
          { type: "input_text", text: "Message Type: NEW_TASK\nPayload:\n" },
          { type: "encrypted_content", encrypted_content: "opaque" },
        ],
      };
      const response = await fetch(`${proxy.origin}/backend-api/codex/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "kimi-k3", input: [encrypted] }),
      });
      expect(response.status).toBe(200);
      expect(forwarded?.input).toEqual([encrypted]);
    } finally {
      delete process.env.ACT_TEST_ROUTE_KEY;
    }
  });

  it("omits legacy-disallowed tools on the WebSocket-to-HTTP bridge", async () => {
    process.env.ACT_TEST_ROUTE_KEY = "local-api-key";
    try {
      let forwarded: Record<string, unknown> | undefined;
      const gateway = await startHttpServer(async (request, response) => {
        forwarded = JSON.parse((await readBody(request)).toString()) as Record<string, unknown>;
        response.setHeader("content-type", "text/event-stream");
        response.end(
          'data: {"type":"response.completed","response":{"id":"resp_1","model":"upstream","status":"completed"}}\n\n',
        );
      });
      const config = routeConfigForTest(gateway.origin);
      const route = modelRouteFromConfig({
        ...config,
        model: { ...config.model, slug: "legacy-bridge" },
        transport: "http",
        allowed_tool_types: ["function"],
      });
      const captures = new MemoryCaptureSink();
      const liveRequests = new LiveRequestStore();
      const proxy = await startRoutingProxy(gateway.origin, captures, {
        routes: [route],
        liveRequests,
      });
      const client = new WebSocket(
        proxy.origin.replace("http://", "ws://") + "/backend-api/codex/responses",
      );
      closeables.push(async () => client.close());
      await opened(client);

      client.send(
        JSON.stringify({
          type: "response.create",
          model: "legacy-bridge",
          input: [],
          tools: [{ type: "function", name: "read" }, { type: "web_search" }],
          tool_choice: { type: "web_search" },
        }),
      );
      expect(JSON.parse(await nextMessage(client))).toMatchObject({ type: "response.completed" });
      expect(forwarded?.tools).toEqual([{ type: "function", name: "read" }]);
      expect(forwarded).not.toHaveProperty("tool_choice");
      expect(
        captures.events.find((event) => event.direction === "client_to_upstream")?.routing,
      ).toMatchObject({ omittedToolTypes: ["web_search"] });
      expect(liveRequests.snapshot().recent[0]?.events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ detail: "Omitted tool types: web_search" }),
        ]),
      );
    } finally {
      delete process.env.ACT_TEST_ROUTE_KEY;
    }
  });

  it("omits tools on a native routed WebSocket before forwarding", async () => {
    process.env.ACT_TEST_ROUTE_KEY = "local-api-key";
    try {
      let forwarded: Record<string, unknown> | undefined;
      const gateway = await startWebSocketServer((socket) => {
        socket.on("message", (message) => {
          forwarded = JSON.parse(rawDataText(message)) as Record<string, unknown>;
          socket.send("routed");
        });
      });
      const config = routeConfigForTest(gateway.origin);
      const route = modelRouteFromConfig({
        ...config,
        model: { ...config.model, slug: "native-omit" },
        tool_policy: { web_search: "omit", other: "omit" },
      });
      const captures = new MemoryCaptureSink();
      const proxy = await startRoutingProxy(gateway.origin, captures, { routes: [route] });
      const client = new WebSocket(
        proxy.origin.replace("http://", "ws://") + "/backend-api/codex/responses",
      );
      closeables.push(async () => client.close());
      await opened(client);

      client.send(
        JSON.stringify({
          type: "response.create",
          model: "native-omit",
          input: [],
          tools: [
            { type: "function", name: "read" },
            { type: "web_search" },
            { type: "future_tool", name: "future" },
          ],
          tool_choice: { type: "web_search" },
        }),
      );
      expect(await nextMessage(client)).toBe("routed");
      expect(forwarded?.tools).toEqual([{ type: "function", name: "read" }]);
      expect(forwarded).not.toHaveProperty("tool_choice");
      expect(
        captures.events.find((event) => event.direction === "client_to_upstream")?.routing,
      ).toMatchObject({ omittedToolTypes: ["web_search", "future_tool"] });
    } finally {
      delete process.env.ACT_TEST_ROUTE_KEY;
    }
  });

  it("rejects disallowed tools before and after a native routed WebSocket connects", async () => {
    process.env.ACT_TEST_ROUTE_KEY = "local-api-key";
    try {
      let connections = 0;
      let deliveries = 0;
      const gateway = await startWebSocketServer((socket) => {
        connections += 1;
        socket.on("message", () => {
          deliveries += 1;
          socket.send("routed");
        });
      });
      const route = modelRouteFromConfig({
        ...routeConfigForTest(gateway.origin),
        tool_policy: { custom: "reject" },
      });
      const proxy = await startRoutingProxy(gateway.origin, new MemoryCaptureSink(), {
        routes: [route],
      });
      const client = new WebSocket(
        proxy.origin.replace("http://", "ws://") + "/backend-api/codex/responses",
      );
      closeables.push(async () => client.close());
      await opened(client);
      const blocked = JSON.stringify({
        type: "response.create",
        model: "kimi-k3",
        input: [],
        tools: [{ type: "custom", name: "apply_patch" }],
      });
      client.send(blocked);
      expect(JSON.parse(await nextMessage(client))).toMatchObject({
        type: "error",
        status: 400,
        error: { message: 'model route "kimi-k3" rejects tool type "custom"' },
      });
      expect(connections).toBe(0);

      client.send(JSON.stringify({ type: "response.create", model: "kimi-k3", input: [] }));
      expect(await nextMessage(client)).toBe("routed");
      client.send(blocked);
      expect(JSON.parse(await nextMessage(client))).toMatchObject({ type: "error", status: 400 });
      client.send(
        JSON.stringify({
          type: "response.create",
          model: "other-model",
          input: [],
          tools: [{ type: "custom", name: "apply_patch" }],
        }),
      );
      expect(JSON.parse(await nextMessage(client))).toMatchObject({ type: "error", status: 400 });
      expect(connections).toBe(1);
      expect(deliveries).toBe(1);
    } finally {
      delete process.env.ACT_TEST_ROUTE_KEY;
    }
  });

  it("bridges a WebSocket response.create to an HTTP-only route and streams SSE back", async () => {
    process.env.OPENAI_API_KEY = "test-gateway-key";
    try {
      const seen: string[] = [];
      const gateway = await startHttpServer((request, response) => {
        let body = "";
        request.on("data", (chunk) => (body += chunk));
        request.on("end", () => {
          const payload = JSON.parse(body) as Record<string, unknown>;
          seen.push(String(payload.model));
          expect(request.headers.authorization).toBe("Bearer test-gateway-key");
          expect(payload.stream).toBe(true);
          expect(payload.type).toBeUndefined();
          expect(payload.client_metadata).toBeUndefined();
          expect(payload.generate).toBeUndefined();
          expect(payload.access_programs).toBeUndefined();
          response.setHeader("content-type", "text/event-stream");
          response.end(
            `event: response.created\ndata: {"type":"response.created","response":{"id":"resp_gw","model":"${String(payload.model)}","status":"in_progress"}}\n\n` +
              `event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"audit-ok"}\n\n` +
              `event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_gw","model":"${String(payload.model)}","status":"completed"}}\n\n`,
          );
        });
      });
      const route = modelRouteFromConfig({
        authorization_env: "OPENAI_API_KEY",
        model: {
          description: "GPT-6 Astra via the AI gateway",
          display_name: "GPT-6 Astra",
          priority: 1,
          slug: "gpt-6-astra",
          template_slug: "gpt-6-astra",
        },
        upstream: `${gateway.origin}/openai/v1`,
        transport: "http",
        targets: [
          { upstream_model: "openai.gpt-6-astra-flex", attempts: 2 },
          { upstream_model: "openai.gpt-6-astra" },
        ],
        retry: { on_status: [429], backoff_ms: [0] },
      });
      const captures = new MemoryCaptureSink();
      const chatgpt = await startWebSocketServer((socket) => {
        socket.on("message", () => socket.send("chatgpt"));
      });
      const proxy = await startRoutingProxy(chatgpt.origin, captures, { routes: [route] });
      const client = new WebSocket(
        proxy.origin.replace("http://", "ws://") + "/backend-api/codex/responses",
        { headers: { authorization: "Bearer oauth-secret" } },
      );
      closeables.push(async () => client.close());
      await opened(client);

      client.send(
        JSON.stringify({
          type: "response.create",
          client_metadata: { session_id: "s" },
          model: "gpt-6-astra",
          input: [],
          access_programs: { cyber: "standard" },
        }),
      );

      const created = JSON.parse(await nextMessage(client)) as {
        type: string;
        response: { id: string; model: string };
      };
      expect(created.type).toBe("response.created");
      expect(created.response.model).toBe("gpt-6-astra");
      expect(created.response.id).toBe("");
      const delta = JSON.parse(await nextMessage(client)) as { type: string };
      expect(delta.type).toBe("response.output_text.delta");
      const completed = JSON.parse(await nextMessage(client)) as {
        type: string;
        response: { id: string; model: string };
      };
      expect(completed.type).toBe("response.completed");
      expect(completed.response.model).toBe("gpt-6-astra");
      expect(completed.response.id).toBe("");

      expect(seen).toEqual(["openai.gpt-6-astra-flex"]);
      await eventually(() => expect(captures.events.length).toBeGreaterThanOrEqual(4));
      expect(captures.events[0]).toMatchObject({
        direction: "client_to_upstream",
        routing: {
          action: "routed",
          requestedModel: "gpt-6-astra",
          upstreamModel: "openai.gpt-6-astra-flex",
          attempts: [{ upstreamModel: "openai.gpt-6-astra-flex", outcome: "served", status: 200 }],
        },
      });
    } finally {
      delete process.env.OPENAI_API_KEY;
    }
  });

  it("translates discovery and retains loaded tools across WebSocket and HTTP stored turns", async () => {
    process.env.ACT_TEST_ROUTE_KEY = "local-api-key";
    try {
      const seen: Record<string, unknown>[] = [];
      const searchCall = {
        type: "function_call",
        id: "fc_search",
        call_id: "search_1",
        name: "tool_search",
        arguments: '{"query":"inventory lookup"}',
        status: "completed",
      };
      const lookupCall = {
        type: "function_call",
        id: "fc_lookup",
        call_id: "lookup_1",
        namespace: "inventory",
        name: "lookup_item",
        arguments: '{"sku":"A"}',
        status: "completed",
      };
      const gateway = await startHttpServer(async (request, response) => {
        const payload = JSON.parse((await readBody(request)).toString()) as Record<string, unknown>;
        seen.push(payload);
        const index = seen.length;
        const output = index === 1 ? [searchCall] : index === 2 ? [lookupCall] : [];
        response.setHeader("content-type", "text/event-stream");
        response.write(
          `data: ${JSON.stringify({ type: "response.created", response: { id: `resp_${index}` } })}\n\n`,
        );
        if (output[0])
          response.write(
            `data: ${JSON.stringify({ type: "response.output_item.done", item: output[0] })}\n\n`,
          );
        response.end(
          `data: ${JSON.stringify({ type: "response.completed", response: { id: `resp_${index}`, output } })}\n\n`,
        );
      });
      const route = modelRouteFromConfig({
        ...routeConfigForTest(gateway.origin),
        transport: "http",
        bridge_response_state: "stored",
        tool_policy: { tool_search: "translate", custom: "omit", other: "omit" },
      });
      const proxy = await startRoutingProxy("http://127.0.0.1:1", new MemoryCaptureSink(), {
        routes: [route],
      });
      const identity = {
        authorization: "Bearer oauth-secret",
        "chatgpt-account-id": "account-1",
        "session-id": "session-1",
        "thread-id": "thread-1",
      };
      const search = {
        type: "tool_search",
        execution: "client",
        description: "Find deferred tools",
        parameters: { type: "object", properties: { query: { type: "string" } } },
      };
      const lookup = {
        type: "namespace",
        name: "inventory",
        tools: [
          {
            type: "function",
            name: "lookup_item",
            description: "Look up a SKU",
            defer_loading: true,
            parameters: { type: "object", properties: { sku: { type: "string" } } },
          },
        ],
      };
      const user = message("user", "Find an inventory lookup tool and look up A");
      const visibleSearchCall = {
        type: "tool_search_call",
        id: "fc_search",
        call_id: "search_1",
        execution: "client",
        arguments: { query: "inventory lookup" },
      };
      const discovery = {
        type: "tool_search_output",
        call_id: "search_1",
        status: "completed",
        execution: "client",
        tools: [lookup],
      };
      const client = new WebSocket(
        proxy.origin.replace("http://", "ws://") + "/backend-api/codex/responses",
        { headers: identity },
      );
      closeables.push(async () => client.close());
      await opened(client);
      const received: Record<string, unknown>[] = [];
      client.on("message", (raw) => received.push(JSON.parse(rawDataText(raw))));
      client.send(
        JSON.stringify({
          type: "response.create",
          model: "kimi-k3",
          input: [user],
          tools: [search],
          tool_choice: { type: "tool_search" },
        }),
      );
      await eventually(() =>
        expect(received.some((event) => event.type === "response.completed")).toBe(true),
      );
      expect(seen[0]).toMatchObject({
        tools: [{ type: "function", name: "tool_search" }],
        tool_choice: { type: "function", name: "tool_search" },
      });
      expect(
        received.find((event) => event.type === "response.output_item.done")?.item,
      ).toMatchObject(visibleSearchCall);
      expect(received.find((event) => event.type === "response.completed")).toMatchObject({
        response: { output: [visibleSearchCall] },
      });

      const second = await fetch(`${proxy.origin}/backend-api/codex/responses`, {
        method: "POST",
        headers: { ...identity, "content-type": "application/json" },
        body: JSON.stringify({
          model: "kimi-k3",
          input: [user, visibleSearchCall, discovery],
          tools: [search],
          stream: true,
        }),
      });
      expect(second.status).toBe(200);
      await second.text();
      expect(seen[1]).toMatchObject({
        previous_response_id: "resp_1",
        input: [
          {
            type: "function_call_output",
            call_id: "search_1",
            output: expect.stringContaining("inventory.lookup_item"),
          },
        ],
        tools: [
          { type: "function", name: "tool_search" },
          { type: "namespace", name: "inventory", tools: [{ name: "lookup_item" }] },
        ],
      });
      expect(JSON.stringify(seen[1]?.tools)).not.toContain("defer_loading");

      client.send(
        JSON.stringify({
          type: "response.create",
          model: "kimi-k3",
          input: [
            user,
            visibleSearchCall,
            discovery,
            lookupCall,
            { type: "function_call_output", call_id: "lookup_1", output: "found" },
          ],
          tools: [search],
        }),
      );
      await eventually(() =>
        expect(received.filter((event) => event.type === "response.completed")).toHaveLength(2),
      );
      expect(seen[2]).toMatchObject({
        previous_response_id: "resp_2",
        input: [{ type: "function_call_output", call_id: "lookup_1", output: "found" }],
        tools: [
          { type: "function", name: "tool_search" },
          { type: "namespace", name: "inventory", tools: [{ name: "lookup_item" }] },
        ],
      });
    } finally {
      delete process.env.ACT_TEST_ROUTE_KEY;
    }
  });

  it("continues a discovered tool call after a proxy restart using persisted route state", async () => {
    process.env.ACT_TEST_ROUTE_KEY = "local-api-key";
    const cacheDirectory = await mkdtemp(join(tmpdir(), "act-route-session-cache-"));
    try {
      const seen: Record<string, unknown>[] = [];
      const searchCall = {
        type: "function_call",
        id: "fc_search",
        call_id: "search_1",
        name: "tool_search",
        arguments: '{"query":"inventory lookup"}',
        status: "completed",
      };
      const lookupCall = {
        type: "function_call",
        id: "fc_lookup",
        call_id: "lookup_1",
        namespace: "inventory",
        name: "lookup_item",
        arguments: '{"sku":"A"}',
        status: "completed",
      };
      const gateway = await startHttpServer(async (request, response) => {
        const payload = JSON.parse((await readBody(request)).toString()) as Record<string, unknown>;
        seen.push(payload);
        const output = seen.length === 1 ? [searchCall] : seen.length === 2 ? [lookupCall] : [];
        response.setHeader("content-type", "text/event-stream");
        response.end(
          `data: ${JSON.stringify({ type: "response.created", response: { id: `resp_${seen.length}` } })}\n\n` +
            `data: ${JSON.stringify({ type: "response.completed", response: { id: `resp_${seen.length}`, output } })}\n\n`,
        );
      });
      const route = modelRouteFromConfig({
        ...routeConfigForTest(gateway.origin),
        transport: "http",
        bridge_response_state: "stored",
        tool_policy: { tool_search: "translate", custom: "omit", other: "omit" },
      });
      const identity = {
        authorization: "Bearer oauth-secret",
        "chatgpt-account-id": "account-1",
        "session-id": "session-1",
        "thread-id": "thread-1",
        "content-type": "application/json",
      };
      const search = {
        type: "tool_search",
        execution: "client",
        description: "Find deferred tools",
        parameters: { type: "object", properties: { query: { type: "string" } } },
      };
      const discovered = {
        type: "namespace",
        name: "inventory",
        tools: [
          {
            type: "function",
            name: "lookup_item",
            description: "Look up a SKU",
            defer_loading: true,
            parameters: { type: "object" },
          },
        ],
      };
      const user = message("user", "Find an inventory lookup tool and look up A");
      const visibleSearchCall = {
        type: "tool_search_call",
        id: "fc_search",
        call_id: "search_1",
        execution: "client",
        arguments: { query: "inventory lookup" },
        status: "completed",
      };
      const discovery = {
        type: "tool_search_output",
        call_id: "search_1",
        status: "completed",
        execution: "client",
        tools: [discovered],
      };
      const send = async (origin: string, input: unknown[]) => {
        const response = await fetch(`${origin}/backend-api/codex/responses`, {
          method: "POST",
          headers: identity,
          body: JSON.stringify({ model: "kimi-k3", stream: true, input, tools: [search] }),
        });
        expect(response.status).toBe(200);
        await response.text();
      };
      const first = await startRoutingProxy("http://127.0.0.1:1", new MemoryCaptureSink(), {
        routes: [route],
        sessionCacheDirectory: cacheDirectory,
      });
      await send(first.origin, [user]);
      await send(first.origin, [user, visibleSearchCall, discovery]);
      await first.close();
      const persisted = (
        await Promise.all([
          readFile(join(cacheDirectory, "loaded-tools-cache.json"), "utf8"),
          readFile(join(cacheDirectory, "stored-responses-cache.json"), "utf8"),
        ])
      ).join("\n");
      for (const secret of ["oauth-secret", "local-api-key", "account-1", gateway.origin]) {
        expect(persisted).not.toContain(secret);
      }

      const restarted = await startRoutingProxy("http://127.0.0.1:1", new MemoryCaptureSink(), {
        routes: [route],
        sessionCacheDirectory: cacheDirectory,
      });
      await send(restarted.origin, [
        user,
        visibleSearchCall,
        discovery,
        lookupCall,
        { type: "function_call_output", call_id: "lookup_1", output: "found" },
      ]);
      expect(seen[2]).toMatchObject({
        previous_response_id: "resp_2",
        input: [{ type: "function_call_output", call_id: "lookup_1", output: "found" }],
        tools: [
          { type: "function", name: "tool_search" },
          { type: "namespace", name: "inventory", tools: [{ name: "lookup_item" }] },
        ],
      });
      await restarted.close();
    } finally {
      delete process.env.ACT_TEST_ROUTE_KEY;
      await rm(cacheDirectory, { recursive: true, force: true });
    }
  });

  it("reports missing loaded-tool state for delta-only continuations on both transports", async () => {
    process.env.ACT_TEST_ROUTE_KEY = "local-api-key";
    try {
      let deliveries = 0;
      const gateway = await startHttpServer((_request, response) => {
        deliveries += 1;
        response.end("unexpected");
      });
      const route = modelRouteFromConfig({
        ...routeConfigForTest(gateway.origin),
        transport: "http",
        bridge_response_state: "stored",
        tool_policy: { tool_search: "translate" },
      });
      const proxy = await startRoutingProxy("http://127.0.0.1:1", new MemoryCaptureSink(), {
        routes: [route],
      });
      const payload = {
        model: "kimi-k3",
        previous_response_id: "resp_old",
        input: [{ type: "function_call_output", call_id: "lookup_1", output: "found" }],
        tools: [
          {
            type: "tool_search",
            execution: "client",
            description: "Find tools",
            parameters: { type: "object" },
          },
        ],
      };
      const http = await fetch(`${proxy.origin}/backend-api/codex/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      expect(http.status).toBe(400);
      expect(await http.text()).toContain("lost loaded tools for a delta-only continuation");

      const client = new WebSocket(
        proxy.origin.replace("http://", "ws://") + "/backend-api/codex/responses",
        {
          headers: {
            authorization: "Bearer oauth-secret",
            "session-id": "new",
            "thread-id": "new",
          },
        },
      );
      closeables.push(async () => client.close());
      await opened(client);
      client.send(JSON.stringify({ type: "response.create", ...payload }));
      expect(JSON.parse(await nextMessage(client))).toMatchObject({
        type: "error",
        status: 400,
        error: {
          message: expect.stringContaining("lost loaded tools for a delta-only continuation"),
        },
      });
      expect(deliveries).toBe(0);
    } finally {
      delete process.env.ACT_TEST_ROUTE_KEY;
    }
  });

  it("injects discovered tools into Anthropic replay and restores namespaced calls", async () => {
    process.env.ACT_TEST_ROUTE_KEY = "local-api-key";
    try {
      const seen: Record<string, unknown>[] = [];
      const gateway = await startHttpServer(async (request, response) => {
        const payload = JSON.parse((await readBody(request)).toString()) as Record<string, unknown>;
        seen.push(payload);
        const name =
          seen.length === 1
            ? "tool_search"
            : (payload.tools as { name: string }[]).find((tool) => tool.name !== "tool_search")!
                .name;
        const id = seen.length === 1 ? "search_1" : "lookup_1";
        const input = seen.length === 1 ? { query: "inventory lookup" } : { sku: "A" };
        response.setHeader("content-type", "text/event-stream");
        for (const event of [
          { type: "message_start", message: { usage: {} } },
          {
            type: "content_block_start",
            index: 0,
            content_block: { type: "tool_use", id, name, input: {} },
          },
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "input_json_delta", partial_json: JSON.stringify(input) },
          },
          { type: "content_block_stop", index: 0 },
          { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: {} },
          { type: "message_stop" },
        ])
          response.write(`data: ${JSON.stringify(event)}\n\n`);
        response.end();
      });
      const route = modelRouteFromConfig({
        ...routeConfigForTest(gateway.origin),
        api: "anthropic-messages",
        tool_policy: { tool_search: "translate" },
      });
      const proxy = await startRoutingProxy("http://127.0.0.1:1", new MemoryCaptureSink(), {
        routes: [route],
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
        tools: [
          {
            type: "function",
            name: "lookup_item",
            defer_loading: true,
            description: "Look up a SKU",
            parameters: { type: "object" },
          },
        ],
      };
      const first = await fetch(`${proxy.origin}/backend-api/codex/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "kimi-k3",
          stream: true,
          input: [message("user", "Find a tool")],
          tools: [search],
        }),
      });
      expect(first.status).toBe(200);
      const firstEvents = (await Array.fromAsync(parseSseEvents(first.body!))).map((event) =>
        JSON.parse(event),
      );
      const firstDone = firstEvents.find(
        (event) => event.type === "response.output_item.done",
      )?.item;
      expect(firstDone).toMatchObject({
        type: "tool_search_call",
        execution: "client",
        arguments: { query: "inventory lookup" },
      });
      const second = await fetch(`${proxy.origin}/backend-api/codex/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "kimi-k3",
          stream: true,
          input: [
            message("user", "Find a tool"),
            firstDone,
            {
              type: "tool_search_output",
              call_id: "search_1",
              execution: "client",
              status: "completed",
              tools: [discovered],
            },
          ],
          tools: [search],
        }),
      });
      expect(second.status).toBe(200);
      const secondEvents = (await Array.fromAsync(parseSseEvents(second.body!))).map((event) =>
        JSON.parse(event),
      );
      expect(
        secondEvents.find((event) => event.type === "response.output_item.done")?.item,
      ).toMatchObject({
        type: "function_call",
        namespace: "inventory",
        name: "lookup_item",
        arguments: '{"sku":"A"}',
      });
      expect(seen[0]?.tools).toMatchObject([{ name: "tool_search" }]);
      expect(seen[1]?.tools).toMatchObject([
        { name: "tool_search" },
        { name: expect.stringMatching(/^tool_/) },
      ]);
      expect(seen[1]?.messages).toMatchObject([
        { role: "user" },
        {
          role: "assistant",
          content: [
            { type: "tool_use", name: "tool_search", input: { query: "inventory lookup" } },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              content: [{ text: expect.stringContaining("inventory.lookup_item") }],
            },
          ],
        },
      ]);
    } finally {
      delete process.env.ACT_TEST_ROUTE_KEY;
    }
  });

  it("converts a matching tool-call replay into a stored upstream continuation", async () => {
    process.env.OPENAI_API_KEY = "test-gateway-key";
    try {
      const seen: Record<string, unknown>[] = [];
      const gateway = await startHttpServer((request, response) => {
        let body = "";
        request.on("data", (chunk) => (body += chunk));
        request.on("end", () => {
          expect(request.url).toBe("/v1/responses");
          const payload = JSON.parse(body) as Record<string, unknown>;
          seen.push(payload);
          const id = `resp_${seen.length}`;
          const output =
            seen.length === 1
              ? [
                  { type: "reasoning", id: "rs_1", summary: [] },
                  {
                    type: "function_call",
                    id: "fc_1",
                    call_id: "sum_numbers_0",
                    name: "sum_numbers",
                    arguments: "{}",
                  },
                ]
              : [];
          response.setHeader("content-type", "text/event-stream");
          response.end(
            `data: {"type":"response.created","response":{"id":"${id}","model":"${String(payload.model)}","status":"in_progress"}}\n\n` +
              `data: ${JSON.stringify({ type: "response.completed", response: { id, model: payload.model, status: "completed", output } })}\n\n`,
          );
        });
      });
      const route = modelRouteFromConfig({
        authorization_env: "OPENAI_API_KEY",
        model: {
          description: "Kimi K3 via a compatible gateway",
          display_name: "Kimi K3",
          priority: 1,
          slug: "kimi-k3",
          template_slug: "gpt-5.6-luna",
        },
        upstream: `${gateway.origin}/v1`,
        upstream_model: "provider/kimi-k3",
        transport: "http",
        bridge_response_state: "stored",
        allowed_tool_types: ["function"],
      });
      const captures = new MemoryCaptureSink();
      const chatgpt = await startWebSocketServer((socket) => {
        socket.on("message", () => socket.send("chatgpt"));
      });
      const proxy = await startRoutingProxy(chatgpt.origin, captures, { routes: [route] });
      const client = new WebSocket(
        proxy.origin.replace("http://", "ws://") + "/backend-api/codex/responses",
        { headers: { authorization: "Bearer oauth-secret" } },
      );
      closeables.push(async () => client.close());
      await opened(client);

      client.send(
        JSON.stringify({
          type: "response.create",
          model: "kimi-k3",
          input: [{ role: "user", content: "Add 19 and 23" }],
          store: false,
          tools: [{ type: "function", name: "sum_numbers" }],
        }),
      );
      const firstCreated = JSON.parse(await nextMessage(client)) as {
        response: { id: string; model: string };
      };
      expect(firstCreated.response).toMatchObject({ id: "resp_1", model: "kimi-k3" });
      await nextMessage(client);

      client.send(
        JSON.stringify({
          type: "response.create",
          model: "kimi-k3",
          input: [
            { role: "user", content: "Add 19 and 23" },
            { type: "reasoning", id: "rs_1" },
            { type: "function_call", id: "fc_1", call_id: "sum_numbers_0" },
            { type: "function_call_output", call_id: "sum_numbers_0", output: "42" },
          ],
          store: false,
        }),
      );
      const secondCreated = JSON.parse(await nextMessage(client)) as {
        response: { id: string; model: string };
      };
      expect(secondCreated.response).toMatchObject({ id: "resp_2", model: "kimi-k3" });
      await nextMessage(client);

      expect(seen).toHaveLength(2);
      expect(seen[0]).toMatchObject({
        model: "provider/kimi-k3",
        store: true,
        tools: [{ type: "function", name: "sum_numbers" }],
      });
      expect(seen[1]).toMatchObject({
        model: "provider/kimi-k3",
        store: true,
        previous_response_id: "resp_1",
        input: [{ type: "function_call_output", call_id: "sum_numbers_0", output: "42" }],
      });
    } finally {
      delete process.env.OPENAI_API_KEY;
    }
  });

  it("translates custom tool calls on a routed HTTP Responses stream", async () => {
    process.env.ACT_TEST_ROUTE_KEY = "local-api-key";
    try {
      const patch = "*** Begin Patch\n*** Add File: note.txt\n+ok\n*** End Patch";
      const argumentsJson = JSON.stringify({ input: patch });
      const seen: Record<string, unknown>[] = [];
      const call = {
        type: "function_call",
        id: "fc_1",
        call_id: "call_1",
        name: "apply_patch",
        arguments: argumentsJson,
        status: "completed",
      };
      const gateway = await startHttpServer(async (request, response) => {
        seen.push(JSON.parse((await readBody(request)).toString()));
        response.setHeader("content-type", "text/event-stream");
        for (const event of [
          { type: "response.created", response: { id: "resp_1" } },
          {
            type: "response.output_item.added",
            output_index: 0,
            item: { ...call, arguments: "", status: "in_progress" },
          },
          {
            type: "response.function_call_arguments.delta",
            item_id: "fc_1",
            output_index: 0,
            delta: argumentsJson.slice(0, 15),
          },
          {
            type: "response.function_call_arguments.delta",
            item_id: "fc_1",
            output_index: 0,
            delta: argumentsJson.slice(15),
          },
          {
            type: "response.function_call_arguments.done",
            item_id: "fc_1",
            output_index: 0,
            arguments: argumentsJson,
          },
          { type: "response.output_item.done", output_index: 0, item: call },
          { type: "response.completed", response: { id: "resp_1", output: [call] } },
        ])
          response.write(`data: ${JSON.stringify(event)}\n\n`);
        response.end();
      });
      const route = modelRouteFromConfig({
        ...routeConfigForTest(gateway.origin),
        transport: "http",
        tool_policy: { custom: "translate" },
      });
      const proxy = await startRoutingProxy("http://127.0.0.1:1", new MemoryCaptureSink(), {
        routes: [route],
      });
      const tools = [{ type: "custom", name: "apply_patch", format: { type: "text" } }];
      const response = await fetch(`${proxy.origin}/backend-api/codex/responses`, {
        method: "POST",
        headers: { authorization: "Bearer oauth-secret", "content-type": "application/json" },
        body: JSON.stringify({
          model: "kimi-k3",
          input: [message("user", "Patch a file")],
          tools,
          tool_choice: { type: "custom", name: "apply_patch" },
          parallel_tool_calls: false,
          stream: true,
        }),
      });
      expect(response.status).toBe(200);
      const events = await Array.fromAsync(parseSseEvents(response.body!)).then((items) =>
        items.map((item) => JSON.parse(item)),
      );
      expect(seen[0]).toMatchObject({
        tools: [
          {
            type: "function",
            name: "apply_patch",
            parameters: { properties: { input: { type: "string" } } },
          },
        ],
        tool_choice: { type: "function", name: "apply_patch" },
        parallel_tool_calls: false,
      });
      expect(events.map((event) => event.type)).toEqual([
        "response.created",
        "response.output_item.added",
        "response.custom_tool_call_input.delta",
        "response.custom_tool_call_input.done",
        "response.output_item.done",
        "response.completed",
      ]);
      expect(events[2].delta).toBe(patch);
      expect(events[4].item).toMatchObject({ type: "custom_tool_call", input: patch });
      expect(events[5].response.output[0]).toMatchObject({
        type: "custom_tool_call",
        input: patch,
      });
    } finally {
      delete process.env.ACT_TEST_ROUTE_KEY;
    }
  });

  it("translates custom calls in a non-streamed HTTP Responses body", async () => {
    process.env.ACT_TEST_ROUTE_KEY = "local-api-key";
    try {
      const gateway = await startHttpServer((_request, response) => {
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            id: "resp_1",
            output: [
              {
                type: "function_call",
                id: "fc_1",
                call_id: "call_1",
                name: "apply_patch",
                arguments: '{"input":"patch"}',
              },
            ],
          }),
        );
      });
      const route = modelRouteFromConfig({
        ...routeConfigForTest(gateway.origin),
        transport: "http",
        tool_policy: { custom: "translate" },
      });
      const proxy = await startRoutingProxy("http://127.0.0.1:1", new MemoryCaptureSink(), {
        routes: [route],
      });
      const response = await fetch(`${proxy.origin}/backend-api/codex/responses`, {
        method: "POST",
        headers: { authorization: "Bearer oauth-secret", "content-type": "application/json" },
        body: JSON.stringify({
          model: "kimi-k3",
          input: "Patch",
          stream: false,
          tools: [{ type: "custom", name: "apply_patch" }],
        }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        output: [{ type: "custom_tool_call", name: "apply_patch", input: "patch" }],
      });
    } finally {
      delete process.env.ACT_TEST_ROUTE_KEY;
    }
  });

  it("matches a translated custom call across WebSocket to HTTP stored continuation", async () => {
    process.env.ACT_TEST_ROUTE_KEY = "local-api-key";
    try {
      const patch = "*** Begin Patch\n*** Add File: note.txt\n+ok\n*** End Patch";
      const call = {
        type: "function_call",
        id: "fc_1",
        call_id: "call_1",
        name: "apply_patch",
        arguments: JSON.stringify({ input: patch }),
        status: "completed",
      };
      const seen: Record<string, unknown>[] = [];
      const gateway = await startHttpServer(async (request, response) => {
        const payload = JSON.parse((await readBody(request)).toString()) as Record<string, unknown>;
        seen.push(payload);
        const id = `resp_${seen.length}`;
        const output = seen.length === 1 ? [call] : [];
        response.setHeader("content-type", "text/event-stream");
        response.write(
          `data: ${JSON.stringify({ type: "response.created", response: { id } })}\n\n`,
        );
        if (seen.length === 1) {
          response.write(
            `data: ${JSON.stringify({ type: "response.output_item.added", output_index: 0, item: { ...call, arguments: "", status: "in_progress" } })}\n\n`,
          );
          response.write(
            `data: ${JSON.stringify({ type: "response.output_item.done", output_index: 0, item: call })}\n\n`,
          );
        }
        response.end(
          `data: ${JSON.stringify({ type: "response.completed", response: { id, output } })}\n\n`,
        );
      });
      const route = modelRouteFromConfig({
        ...routeConfigForTest(gateway.origin),
        transport: "http",
        bridge_response_state: "stored",
        tool_policy: { custom: "translate" },
      });
      const proxy = await startRoutingProxy("http://127.0.0.1:1", new MemoryCaptureSink(), {
        routes: [route],
      });
      const identity = {
        authorization: "Bearer oauth-secret",
        "chatgpt-account-id": "account-1",
        "session-id": "session-1",
        "thread-id": "thread-1",
      };
      const tools = [{ type: "custom", name: "apply_patch", format: { type: "text" } }];
      const user = message("user", "Patch a file");
      const client = new WebSocket(
        proxy.origin.replace("http://", "ws://") + "/backend-api/codex/responses",
        { headers: identity },
      );
      closeables.push(async () => client.close());
      await opened(client);
      const received: Record<string, unknown>[] = [];
      client.on("message", (raw) => received.push(JSON.parse(rawDataText(raw))));
      client.send(
        JSON.stringify({ type: "response.create", model: "kimi-k3", input: [user], tools }),
      );
      await eventually(() =>
        expect(received.some((event) => event.type === "response.completed")).toBe(true),
      );
      expect(
        received.find((event) => event.type === "response.output_item.done")?.item,
      ).toMatchObject({ type: "custom_tool_call", input: patch });
      expect(
        received.find((event) => event.type === "response.custom_tool_call_input.delta")?.delta,
      ).toBe(patch);

      const followup = await fetch(`${proxy.origin}/backend-api/codex/responses`, {
        method: "POST",
        headers: { ...identity, "content-type": "application/json" },
        body: JSON.stringify({
          model: "kimi-k3",
          input: [
            user,
            {
              type: "custom_tool_call",
              id: "fc_1",
              call_id: "call_1",
              name: "apply_patch",
              input: patch,
            },
            { type: "custom_tool_call_output", call_id: "call_1", output: "done" },
          ],
          tools,
          stream: true,
        }),
      });
      expect(followup.status).toBe(200);
      await followup.text();
      expect(seen[1]).toMatchObject({
        previous_response_id: "resp_1",
        input: [{ type: "function_call_output", call_id: "call_1", output: "done" }],
      });
    } finally {
      delete process.env.ACT_TEST_ROUTE_KEY;
    }
  });

  it("continues stored responses across WebSocket and direct HTTP in both directions", async () => {
    process.env.ACT_TEST_ROUTE_KEY = "local-api-key";
    try {
      const seen: Record<string, unknown>[] = [];
      const firstOutput = [
        { type: "reasoning", id: "rs_1", summary: [] },
        { type: "function_call", id: "fc_1", call_id: "call_1", name: "compute", arguments: "{}" },
      ];
      const secondOutput = [
        { type: "reasoning", id: "rs_2", summary: [] },
        { type: "function_call", id: "fc_2", call_id: "call_2", name: "compute", arguments: "{}" },
      ];
      const gateway = await startHttpServer(async (request, response) => {
        const payload = JSON.parse((await readBody(request)).toString()) as Record<string, unknown>;
        seen.push(payload);
        const id = `resp_${seen.length}`;
        const output = seen.length === 1 ? firstOutput : seen.length === 2 ? secondOutput : [];
        response.setHeader("content-type", "text/event-stream");
        response.write(
          `data: ${JSON.stringify({ type: "response.created", response: { id } })}\n\n`,
        );
        response.end(
          `data: ${JSON.stringify({ type: "response.completed", response: { id, output } })}\n\n`,
        );
      });
      const route = {
        ...testRoute(gateway.origin),
        transport: "http" as const,
        bridgeResponseState: "stored" as const,
      };
      const proxy = await startRoutingProxy("http://127.0.0.1:1", new MemoryCaptureSink(), {
        routes: [route],
      });
      const identity = {
        authorization: "Bearer oauth-secret",
        "chatgpt-account-id": "account-1",
        "session-id": "session-1",
        "thread-id": "thread-1",
      };
      const user = { role: "user", content: "Compute a value" };
      const firstResult = { type: "function_call_output", call_id: "call_1", output: "42" };
      const secondResult = { type: "function_call_output", call_id: "call_2", output: "84" };
      const client = new WebSocket(
        proxy.origin.replace("http://", "ws://") + "/backend-api/codex/responses",
        { headers: identity },
      );
      closeables.push(async () => client.close());
      await opened(client);
      client.send(JSON.stringify({ type: "response.create", model: "kimi-k3", input: [user] }));
      await nextMessage(client);
      await nextMessage(client);
      client.close();

      const firstReplay = {
        model: "kimi-k3",
        input: [
          user,
          { type: "reasoning", id: "rs_1" },
          { type: "function_call", id: "fc_1", call_id: "call_1" },
          firstResult,
        ],
        store: false,
        stream: true,
      };
      const fallback = await fetch(`${proxy.origin}/backend-api/codex/responses`, {
        method: "POST",
        headers: { ...identity, "content-type": "application/json" },
        body: JSON.stringify(firstReplay),
      });
      expect(fallback.status).toBe(200);
      expect(await fallback.text()).toContain('"id":"resp_2"');
      expect(seen[1]).toMatchObject({
        previous_response_id: "resp_1",
        input: [firstResult],
        store: true,
      });

      const unrelated = await fetch(`${proxy.origin}/backend-api/codex/responses`, {
        method: "POST",
        headers: { ...identity, "thread-id": "thread-2", "content-type": "application/json" },
        body: JSON.stringify(firstReplay),
      });
      await unrelated.text();
      expect(seen[2]).toMatchObject({ input: firstReplay.input });
      expect(seen[2]).not.toHaveProperty("previous_response_id");

      const resumed = new WebSocket(
        proxy.origin.replace("http://", "ws://") + "/backend-api/codex/responses",
        { headers: identity },
      );
      closeables.push(async () => resumed.close());
      await opened(resumed);
      resumed.send(
        JSON.stringify({
          type: "response.create",
          model: "kimi-k3",
          input: [
            ...firstReplay.input,
            { type: "reasoning", id: "rs_2" },
            { type: "function_call", id: "fc_2", call_id: "call_2" },
            secondResult,
          ],
        }),
      );
      await nextMessage(resumed);
      await nextMessage(resumed);
      expect(seen[3]).toMatchObject({
        previous_response_id: "resp_2",
        input: [secondResult],
        store: true,
      });
    } finally {
      delete process.env.ACT_TEST_ROUTE_KEY;
    }
  });

  it("fails over a bridged SSE rate_limit_exceeded to the regular model", async () => {
    process.env.OPENAI_API_KEY = "test-gateway-key";
    try {
      const seen: string[] = [];
      const gateway = await startHttpServer((request, response) => {
        let body = "";
        request.on("data", (chunk) => (body += chunk));
        request.on("end", () => {
          const model = String((JSON.parse(body) as { model: string }).model);
          seen.push(model);
          response.setHeader("content-type", "text/event-stream");
          if (model.endsWith("-flex")) {
            response.end(
              `data: {"type":"response.created","response":{"status":"in_progress"}}\n\n` +
                `data: {"type":"error","error":{"code":"rate_limit_exceeded","message":"We're currently processing too many requests — please try again later."}}\n\n` +
                `data: {"type":"response.failed","response":{"status":"failed","error":{"code":"rate_limit_exceeded"}}}\n\n`,
            );
            return;
          }
          response.end(
            `data: {"type":"response.created","response":{"id":"resp_std","model":"${model}","status":"in_progress"}}\n\n` +
              `data: {"type":"response.output_text.delta","delta":"ok"}\n\n` +
              `data: {"type":"response.completed","response":{"id":"resp_std","model":"${model}","status":"completed"}}\n\n`,
          );
        });
      });
      const route = modelRouteFromConfig({
        authorization_env: "OPENAI_API_KEY",
        model: {
          description: "GPT-6 Astra via the AI gateway",
          display_name: "GPT-6 Astra",
          priority: 1,
          slug: "gpt-6-astra",
          template_slug: "gpt-6-astra",
        },
        upstream: `${gateway.origin}/openai/v1`,
        transport: "http",
        targets: [
          { upstream_model: "openai.gpt-6-astra-flex", attempts: 2 },
          { upstream_model: "openai.gpt-6-astra" },
        ],
        retry: { on_status: [429], backoff_ms: [0] },
      });
      const captures = new MemoryCaptureSink();
      const chatgpt = await startWebSocketServer((socket) => {
        socket.on("message", () => socket.send("chatgpt"));
      });
      const proxy = await startRoutingProxy(chatgpt.origin, captures, { routes: [route] });
      const client = new WebSocket(
        proxy.origin.replace("http://", "ws://") + "/backend-api/codex/responses",
        { headers: { authorization: "Bearer oauth-secret" } },
      );
      closeables.push(async () => client.close());
      await opened(client);

      client.send(JSON.stringify({ type: "response.create", model: "gpt-6-astra", input: [] }));

      const created = JSON.parse(await nextMessage(client)) as { type: string };
      expect(created.type).toBe("response.created");
      expect(JSON.parse(await nextMessage(client))).toMatchObject({
        type: "response.output_text.delta",
        delta: "ok",
      });
      expect(seen).toEqual([
        "openai.gpt-6-astra-flex",
        "openai.gpt-6-astra-flex",
        "openai.gpt-6-astra",
      ]);
      await eventually(() =>
        expect(captures.events[0]).toMatchObject({
          direction: "client_to_upstream",
          routing: {
            requestedModel: "gpt-6-astra",
            upstreamModel: "openai.gpt-6-astra",
            attempts: [
              { upstreamModel: "openai.gpt-6-astra-flex", outcome: "retry", status: 429 },
              { upstreamModel: "openai.gpt-6-astra-flex", outcome: "retry", status: 429 },
              { upstreamModel: "openai.gpt-6-astra", outcome: "served", status: 200 },
            ],
          },
        }),
      );
    } finally {
      delete process.env.OPENAI_API_KEY;
    }
  });

  it("answers a bridged generate:false warmup locally without touching the gateway", async () => {
    process.env.OPENAI_API_KEY = "test-gateway-key";
    try {
      let gatewayRequests = 0;
      const gateway = await startHttpServer((_request, response) => {
        gatewayRequests += 1;
        response.statusCode = 500;
        response.end("should not be called");
      });
      const route = modelRouteFromConfig({
        authorization_env: "OPENAI_API_KEY",
        model: {
          description: "GPT-6 Astra via the AI gateway",
          display_name: "GPT-6 Astra",
          priority: 1,
          slug: "gpt-6-astra",
          template_slug: "gpt-6-astra",
        },
        upstream: `${gateway.origin}/openai/v1`,
        transport: "http",
        targets: [{ upstream_model: "openai.gpt-6-astra-flex" }],
      });
      const captures = new MemoryCaptureSink();
      const chatgpt = await startWebSocketServer((socket) => {
        socket.on("message", () => socket.send("chatgpt"));
      });
      const proxy = await startRoutingProxy(chatgpt.origin, captures, { routes: [route] });
      const client = new WebSocket(
        proxy.origin.replace("http://", "ws://") + "/backend-api/codex/responses",
        { headers: { authorization: "Bearer oauth-secret" } },
      );
      closeables.push(async () => client.close());
      await opened(client);

      client.send(
        JSON.stringify({ type: "response.create", generate: false, model: "gpt-6-astra" }),
      );

      const created = JSON.parse(await nextMessage(client)) as {
        type: string;
        response: { model: string; status: string };
      };
      expect(created.type).toBe("response.created");
      expect(created.response).toMatchObject({ model: "gpt-6-astra", status: "in_progress" });
      const completed = JSON.parse(await nextMessage(client)) as {
        type: string;
        response: { model: string; status: string };
      };
      expect(completed.type).toBe("response.completed");
      expect(completed.response).toMatchObject({ model: "gpt-6-astra", status: "completed" });

      expect(gatewayRequests).toBe(0);
      await eventually(() => expect(captures.events.length).toBeGreaterThanOrEqual(3));
      expect(captures.events[0]).toMatchObject({
        direction: "client_to_upstream",
        routing: { action: "routed", requestedModel: "gpt-6-astra" },
      });
    } finally {
      delete process.env.OPENAI_API_KEY;
    }
  });

  it("sends a wrapped error event when every bridged target is exhausted", async () => {
    process.env.OPENAI_API_KEY = "test-gateway-key";
    try {
      const gateway = await startHttpServer((_request, response) => {
        response.statusCode = 429;
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({ error: { code: "resource_unavailable", message: "no flex" } }),
        );
      });
      const route = modelRouteFromConfig({
        authorization_env: "OPENAI_API_KEY",
        model: {
          description: "GPT-6 Astra via the AI gateway",
          display_name: "GPT-6 Astra",
          priority: 1,
          slug: "gpt-6-astra",
          template_slug: "gpt-6-astra",
        },
        upstream: `${gateway.origin}/openai/v1`,
        transport: "http",
        targets: [{ upstream_model: "openai.gpt-6-astra-flex", attempts: 2 }],
        retry: { on_status: [429], backoff_ms: [0] },
      });
      const captures = new MemoryCaptureSink();
      const chatgpt = await startWebSocketServer((socket) => {
        socket.on("message", () => socket.send("chatgpt"));
      });
      const proxy = await startRoutingProxy(chatgpt.origin, captures, {
        routes: [route],
      });
      const client = new WebSocket(
        proxy.origin.replace("http://", "ws://") + "/backend-api/codex/responses",
        { headers: { authorization: "Bearer oauth-secret" } },
      );
      closeables.push(async () => client.close());
      await opened(client);

      client.send(JSON.stringify({ type: "response.create", model: "gpt-6-astra", input: [] }));

      const error = JSON.parse(await nextMessage(client)) as {
        type: string;
        status: number;
        error: { code: string; message: string };
      };
      expect(error).toEqual({
        type: "error",
        status: 429,
        error: { code: "resource_unavailable", message: "no flex" },
      });
      await eventually(() =>
        expect(captures.events.some((event) => event.errorSummary !== undefined)).toBe(true),
      );
      expect(
        captures.events.find((event) => event.direction === "upstream_to_client"),
      ).toMatchObject({
        origin: {
          kind: "gateway-http",
          url: `${gateway.origin}/openai/v1/responses`,
        },
        errorSummary: {
          eventType: "error",
          status: 429,
          code: "resource_unavailable",
          message: "no flex",
        },
      });

      // The socket survives: an unrouted model still flows to the default WS upstream.
      client.send(JSON.stringify({ type: "response.create", model: "gpt-5.6-terra", input: [] }));
      expect(await nextMessage(client)).toBe("chatgpt");
    } finally {
      delete process.env.OPENAI_API_KEY;
    }
  });

  it("keeps unmatched WebSocket models on the default upstream", async () => {
    const chatgpt = await startWebSocketServer((socket, request) => {
      expect(request.headers.authorization).toBe("Bearer oauth-secret");
      socket.on("message", () => socket.send("chatgpt"));
    });
    const proxy = await startRoutingProxy(chatgpt.origin, new MemoryCaptureSink(), {
      routes: [testRoute("http://127.0.0.1:1")],
    });
    const client = new WebSocket(
      proxy.origin.replace("http://", "ws://") + "/backend-api/codex/responses",
      { headers: { authorization: "Bearer oauth-secret" } },
    );
    closeables.push(async () => client.close());
    await opened(client);

    client.send(JSON.stringify({ type: "response.create", model: "gpt-5.6", input: [] }));

    expect(await nextMessage(client)).toBe("chatgpt");
  });
});

describe("sanitizeCloseCode", () => {
  it("keeps valid codes and drops reserved ones", () => {
    expect(sanitizeCloseCode(1000)).toBe(1000);
    expect(sanitizeCloseCode(1011)).toBe(1011);
    expect(sanitizeCloseCode(3000)).toBe(3000);
    expect(sanitizeCloseCode(1004)).toBeUndefined();
    expect(sanitizeCloseCode(1005)).toBeUndefined();
    expect(sanitizeCloseCode(1006)).toBeUndefined();
    expect(sanitizeCloseCode(1015)).toBeUndefined();
    expect(sanitizeCloseCode(2999)).toBeUndefined();
  });
});

async function startProxy(
  upstreamOrigin: string,
  captureSink: CaptureSink,
  transformations: Transformation[] = [],
): Promise<RunningProxy> {
  const proxy = await startReverseProxy({
    host: "127.0.0.1",
    port: 0,
    upstreamOrigin,
    captureSink,
    transformationSource: { get: () => transformations },
  });
  closeables.push(() => proxy.close());
  return proxy;
}

async function startRoutingProxy(
  upstreamOrigin: string,
  captureSink: CaptureSink,
  options: {
    routes?: ModelRoute[];
    adjustments?: ModelAdjustment[];
    fixturePins?: string[];
    fixtureModels?: ModelDefinition[];
    bundleOverride?: ConfigBundleOverride;
    upstreamCache?: MemoryUpstreamCache;
    transformations?: Transformation[];
    liveRequests?: LiveRequestStore;
    sessionCacheDirectory?: string;
    proxyConfigSource?: Pick<ProxyConfigStore, "get" | "subscribe">;
  } = {},
): Promise<RunningProxy> {
  const proxy = await startReverseProxy({
    host: "127.0.0.1",
    port: 0,
    upstreamOrigin,
    captureSink,
    transformationSource: { get: () => options.transformations ?? [] },
    modelRouteSource: {
      get: () => ({
        routes: options.routes ?? [],
        adjustments: options.adjustments ?? [],
        fixturePins: options.fixturePins ?? [],
      }),
    },
    ...(options.fixtureModels === undefined ? {} : { fixtureModels: options.fixtureModels }),
    configBundleSource: {
      get: () => options.bundleOverride ?? { version: 1, enabled: false, bundle: null },
    },
    ...(options.upstreamCache === undefined ? {} : { upstreamCache: options.upstreamCache }),
    ...(options.liveRequests === undefined ? {} : { liveRequests: options.liveRequests }),
    ...(options.sessionCacheDirectory === undefined
      ? {}
      : { sessionCacheDirectory: options.sessionCacheDirectory }),
    ...(options.proxyConfigSource === undefined
      ? {}
      : { proxyConfigSource: options.proxyConfigSource }),
  });
  closeables.push(() => proxy.close());
  return proxy;
}

class MemoryUpstreamCache implements UpstreamCacheStore {
  state: UpstreamCacheState = {};

  get(): UpstreamCacheState {
    return this.state;
  }

  async observe(kind: UpstreamCacheKind, body: unknown) {
    this.state = { ...this.state, [kind]: { fetchedAt: new Date().toISOString(), body } };
  }
}

function testRoute(upstreamOrigin: string): ModelRoute {
  return modelRouteFromConfig(routeConfigForTest(upstreamOrigin));
}

function routeConfigForTest(upstreamOrigin: string): ModelRouteConfig {
  return {
    authorization_env: "ACT_TEST_ROUTE_KEY",
    model: {
      description: "Kimi K3 via CLIProxyAPI",
      display_name: "Kimi K3",
      priority: 1,
      slug: "kimi-k3",
      template_slug: "gpt-5.6-terra",
    },
    upstream: `${upstreamOrigin}/v1`,
    upstream_model: "moonshot-kimi-k3",
  };
}

function routedChildRoute(upstreamOrigin: string): ModelRoute {
  const config = routeConfigForTest(upstreamOrigin);
  return modelRouteFromConfig({
    ...config,
    transport: "http",
    handoff_class: "plaintext",
    model: { ...config.model, slug: "glm-5.3-flash" },
  });
}

function routedAgentsConfig(): Pick<ProxyConfigStore, "get" | "subscribe"> {
  return {
    get: () => ({
      version: 1,
      appsAuthRelay: true,
      search_broker: { route: "gpt-6-luna" },
      routed_agents: { enabled: true, prefer_native_spawn_models: false },
    }),
    subscribe: () => () => {},
  };
}

function collaborationDeclaration() {
  return {
    type: "namespace",
    name: "collaboration",
    tools: ["spawn_agent", "send_message", "followup_task"].map((name) => ({
      type: "function",
      name,
      parameters: {
        type: "object",
        properties: {
          message: { type: "string", encrypted: true },
          ...(name === "spawn_agent"
            ? { model: { type: "string" }, task_name: { type: "string" } }
            : { target: { type: "string" } }),
        },
        required: name === "spawn_agent" ? ["task_name", "message"] : ["target", "message"],
      },
    })),
  };
}

function message(role: string, text: string) {
  return { type: "message", role, content: [{ type: "input_text", text }] };
}

async function startHttpServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<{ origin: string }> {
  const server = createServer(handler);
  await listen(server);
  closeables.push(() => closeServer(server));
  return { origin: serverOrigin(server) };
}

async function startWebSocketServer(
  onConnection: (socket: WebSocket, request: IncomingMessage) => void,
): Promise<{ origin: string }> {
  const server = createServer();
  const webSocketServer = new WebSocketServer({ server });
  webSocketServer.on("connection", onConnection);
  await listen(server);
  closeables.push(
    () =>
      new Promise<void>((resolve) => {
        webSocketServer.close(() => resolve());
      }),
  );
  closeables.push(() => closeServer(server));
  return { origin: serverOrigin(server) };
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function serverOrigin(server: Server): string {
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function opened(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
}

function nextMessage(socket: WebSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    socket.once("message", (message) => resolve(rawDataText(message)));
    socket.once("error", reject);
  });
}

function rawDataText(message: RawData): string {
  if (Array.isArray(message)) return Buffer.concat(message).toString();
  if (message instanceof ArrayBuffer) return Buffer.from(message).toString();
  return Buffer.from(message.buffer, message.byteOffset, message.byteLength).toString();
}

async function eventually(assertion: () => void): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      assertion();
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  assertion();
}
