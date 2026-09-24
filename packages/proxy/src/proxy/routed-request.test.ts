import { afterEach, describe, expect, it } from "vite-plus/test";

import { modelRouteFromConfig } from "../routing/model-routes.ts";
import { prepareRoutedRequest, type RoutedRequestContext } from "./routed-request.ts";
import { StoredResponseRegistry } from "./stored-response-continuation.ts";
import { LoadedToolRegistry } from "./tool-search.ts";

const route = modelRouteFromConfig({
  authorization_env: "ROUTED_PREPARATION_TEST_KEY",
  upstream: "https://gateway.example/v1",
  transport: "http",
  bridge_response_state: "stored",
  tool_policy: { custom: "translate" },
  model: {
    slug: "flash-test",
    display_name: "Flash test",
    description: "Test route",
    template_slug: "gpt-6-astra",
    priority: 1,
  },
});

const declarations = [
  { type: "custom", name: "apply_patch", description: "Patch a file" },
  {
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
  },
];

function context(payload: Record<string, unknown>): RoutedRequestContext {
  return {
    route,
    routes: [route],
    payload,
    search: "",
    sessionKey: "session-key",
    storedResponses: new StoredResponseRegistry(),
    loadedTools: new LoadedToolRegistry(),
  };
}

afterEach(() => {
  delete process.env.ROUTED_PREPARATION_TEST_KEY;
});

describe("shared routed request preparation", () => {
  it("prepares the same tool history, declaration, and continuation for HTTP and bridged WebSocket", () => {
    process.env.ROUTED_PREPARATION_TEST_KEY = "test-token";
    const payload = {
      model: "flash-test",
      input: [
        { role: "user", content: "Patch the file" },
        { type: "custom_tool_call", call_id: "call_patch", name: "apply_patch", input: "patch" },
        { type: "custom_tool_call_output", call_id: "call_patch", output: "done" },
      ],
      tools: declarations,
      stream: true,
    };
    const direct = prepareRoutedRequest(context(payload));
    const bridged = prepareRoutedRequest({ ...context(payload), localWarmup: true });
    expect(direct.kind).toBe("ready");
    expect(bridged.kind).toBe("ready");
    if (direct.kind !== "ready" || bridged.kind !== "ready") return;
    expect(bridged.translatedPayload).toEqual(direct.translatedPayload);
    expect(bridged.responseStateKey).toBe(direct.responseStateKey);
    expect(bridged.storedRequest?.inputMarkers).toEqual(direct.storedRequest?.inputMarkers);
    expect(direct.translatedPayload).toMatchObject({
      store: true,
      tools: [
        { type: "function", name: "apply_patch", parameters: { required: ["input"] } },
        {
          type: "namespace",
          name: "collaboration",
          tools: [
            {
              parameters: { properties: { message: { type: "string" } } },
            },
          ],
        },
      ],
      input: [
        { role: "user" },
        { type: "function_call", call_id: "call_patch", name: "apply_patch" },
        { type: "function_call_output", call_id: "call_patch" },
      ],
    });
  });

  it("answers bridged warmups before authorization and continuation preparation", () => {
    const payload = { model: "flash-test", input: [], tools: declarations, generate: false };
    expect(prepareRoutedRequest({ ...context(payload), localWarmup: true })).toMatchObject({
      kind: "warmup",
    });
    expect(prepareRoutedRequest(context(payload))).toMatchObject({
      kind: "failed",
      phase: "upstream",
    });
  });
});
