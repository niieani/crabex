import { describe, expect, it } from "vite-plus/test";

import { observePayload } from "./payload-observation.ts";

describe("payload observation", () => {
  it("recognizes harness-injected user messages without treating them as real input", () => {
    const observation = observePayload(
      JSON.stringify({
        type: "response.create",
        input: [
          message("developer", "later developer injection"),
          message("user", "<environment_context>\ncontext"),
        ],
      }),
      "client_to_upstream",
    );

    expect(observation.requestSummary).toMatchObject({
      hasRealUserMessage: false,
      messages: [
        { role: "developer", characters: 25 },
        { role: "user", classificationId: "segment:environment" },
      ],
    });
  });

  it("recognizes string and ordinary user input", () => {
    expect(
      observePayload(
        JSON.stringify({ type: "response.create", input: "hello" }),
        "client_to_upstream",
      ).requestSummary,
    ).toMatchObject({ hasRealUserMessage: true, messages: [{ role: "user", characters: 5 }] });
    expect(
      observePayload(
        JSON.stringify({ type: "response.create", input: [message("user", "hello")] }),
        "client_to_upstream",
      ).requestSummary?.hasRealUserMessage,
    ).toBe(true);
  });
});

function message(role: string, text: string) {
  return { type: "message", role, content: [{ type: "input_text", text }] };
}
