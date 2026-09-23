import { describe, expect, it } from "vite-plus/test";

import {
  completedStoredResponse,
  continuationSessionKey,
  prepareStoredRequest,
  StoredResponseRegistry,
  storedResponseKey,
} from "./stored-response-continuation.ts";

const firstInput = [{ type: "message", role: "user", content: "Run pwd" }];
const firstOutput = [
  { type: "reasoning", id: "rs_1", summary: [{ text: "Use the tool" }] },
  {
    type: "function_call",
    id: "fc_1",
    call_id: "exec_1",
    name: "exec_command",
    arguments: '{"cmd":"pwd"}',
  },
];

function state() {
  const prepared = prepareStoredRequest({ input: firstInput }, "kimi-k3");
  return completedStoredResponse(
    JSON.stringify({
      type: "response.completed",
      response: { id: "resp_1", output: firstOutput },
    }),
    "kimi-k3",
    prepared.inputMarkers,
  );
}

describe("stored response continuation", () => {
  it("sends only the new tool result when Codex replays the preceding response", () => {
    const output = { type: "function_call_output", call_id: "exec_1", output: "directory" };
    const replay = {
      input: [
        ...firstInput,
        { type: "reasoning", id: "rs_1" },
        { type: "function_call", id: "fc_1", call_id: "exec_1" },
        output,
      ],
    };

    expect(prepareStoredRequest(replay, "kimi-k3", state()).payload).toEqual({
      input: [output],
      previous_response_id: "resp_1",
    });
  });

  it("keeps a full request when the replayed history or route differs", () => {
    const changed = { input: [{ ...firstInput[0], content: "Run something else" }] };
    expect(prepareStoredRequest(changed, "kimi-k3", state()).payload).toEqual(changed);
    const replay = { input: [...firstInput, ...firstOutput, { role: "user", content: "Next" }] };
    expect(prepareStoredRequest(replay, "glm-5.3", state()).payload).toEqual(replay);
  });

  it("keeps an explicit previous response ID and tracks its logical input", () => {
    const toolOutput = { type: "function_call_output", call_id: "exec_1", output: "directory" };
    const prepared = prepareStoredRequest(
      { input: [toolOutput], previous_response_id: "resp_1" },
      "kimi-k3",
      state(),
    );
    expect(prepared.payload).toEqual({ input: [toolOutput], previous_response_id: "resp_1" });
    const next = completedStoredResponse(
      JSON.stringify({
        type: "response.completed",
        response: { id: "resp_2", output: [{ type: "message", id: "msg_2" }] },
      }),
      "kimi-k3",
      prepared.inputMarkers,
    );
    const nextUser = { role: "user", content: "Another task" };
    const fullReplay = {
      input: [
        ...firstInput,
        { type: "reasoning", id: "rs_1" },
        { type: "function_call", id: "fc_1", call_id: "exec_1" },
        toolOutput,
        { type: "message", id: "msg_2" },
        nextUser,
      ],
    };
    expect(prepareStoredRequest(fullReplay, "kimi-k3", next).payload).toEqual({
      input: [nextUser],
      previous_response_id: "resp_2",
    });
  });

  it("does not record a completed response without output IDs", () => {
    expect(
      completedStoredResponse(
        JSON.stringify({
          type: "response.completed",
          response: { id: "resp_1", output: [{ type: "reasoning" }] },
        }),
        "kimi-k3",
        prepareStoredRequest({ input: firstInput }, "kimi-k3").inputMarkers,
      ),
    ).toBeUndefined();
  });

  it("shares only matching client and route scopes, and expires old state", () => {
    const headers = new Headers({
      "session-id": "session-1",
      "thread-id": "thread-1",
      "chatgpt-account-id": "account-1",
      authorization: "Bearer private-token",
    });
    const scope = continuationSessionKey(headers);
    const key = storedResponseKey(
      scope,
      "kimi-k3",
      "https://gateway.example.test/v1/responses",
      "provider/kimi-k3",
      "Bearer provider-token",
    );
    expect(scope).toBeDefined();
    expect(key).toBeDefined();
    expect(key).not.toContain("private-token");
    expect(key).not.toBe(
      storedResponseKey(
        scope,
        "kimi-k3",
        "https://gateway.example.test/v1/responses",
        "flash",
        "Bearer provider-token",
      ),
    );
    headers.set("thread-id", "thread-2");
    expect(continuationSessionKey(headers)).not.toBe(scope);
    headers.delete("session-id");
    expect(continuationSessionKey(headers)).toBeUndefined();

    let now = 0;
    const registry = new StoredResponseRegistry(() => now);
    registry.set(key, state()!);
    expect(registry.get(key)?.responseId).toBe("resp_1");
    now = 30 * 60_000;
    expect(registry.get(key)).toBeUndefined();
  });
});
