import { describe, expect, it } from "vite-plus/test";
import { ForeignHistoryError, sanitizeMixedProviderHistory } from "./mixed-provider-history.ts";

const text = (value: string) => ({
  type: "message",
  role: "assistant",
  content: [{ type: "output_text", text: value }],
});
const task = {
  type: "agent_message",
  author: "/root",
  recipient: "/root/worker",
  content: [{ type: "input_text", text: "Message Type: NEW_TASK\nPayload:\nReply OK" }],
};

describe("mixed-provider history", () => {
  it("drops inherited Anthropic and Fireworks reasoning before a native child's task", () => {
    const inherited = [
      { type: "reasoning", id: "anthropic", encrypted_content: "acta1:sealed" },
      { type: "reasoning", id: "fireworks", summary: [{ text: "Summary" }] },
    ];
    const own = { type: "reasoning", id: "native", encrypted_content: "gAAAA-native" };
    const payload = {
      model: "gpt-5.6-luna",
      input: [...inherited, text("Public answer"), task, own],
    };
    const sanitized = sanitizeMixedProviderHistory(payload, {
      target: "native",
      sourceModel: "anthropic.claude-haiku-4-5",
    });
    expect(sanitized.input).toEqual([text("Public answer"), task, own]);
    expect(payload.input).toHaveLength(5);
  });

  it("drops native ciphertext on a routed Responses fork and preserves its own plain reasoning", () => {
    const foreign = { type: "reasoning", id: "native", encrypted_content: "gAAAA-native" };
    const own = { type: "reasoning", id: "fireworks", summary: [{ text: "Safe summary" }] };
    const sanitized = sanitizeMixedProviderHistory(
      { model: "glm-5.3-flash", input: [foreign, task, own] },
      { target: "responses", sourceModel: "gpt-5.6-luna" },
    );
    expect(sanitized.input).toEqual([task, own]);
  });

  it("drops opaque reasoning on Responses even when parent provenance was lost", () => {
    const own = { type: "reasoning", summary: [{ text: "Plain provider summary" }] };
    const sanitized = sanitizeMixedProviderHistory(
      {
        model: "glm-5.3-flash",
        input: [{ type: "reasoning", encrypted_content: "gAAAA-native" }, task, own],
      },
      { target: "responses" },
    );
    expect(sanitized.input).toEqual([task, own]);
  });

  it("drops foreign reasoning before an Anthropic fork but retains its sealed own state", () => {
    const own = { type: "reasoning", id: "claude", encrypted_content: "acta1:own" };
    const sanitized = sanitizeMixedProviderHistory(
      {
        model: "anthropic.claude-haiku-4-5",
        input: [
          { type: "reasoning", id: "native", encrypted_content: "gAAAA-native" },
          { type: "reasoning", id: "fireworks", summary: [{ text: "Other summary" }] },
          task,
          own,
        ],
      },
      { target: "anthropic", sourceModel: "glm-5.3-flash" },
    );
    expect(sanitized.input).toEqual([task, own]);
  });

  it("keeps same-model fork and ordinary replay reasoning unchanged", () => {
    const own = { type: "reasoning", encrypted_content: "acta1:own" };
    const payload = { model: "anthropic.claude-haiku-4-5", input: [own, task] };
    expect(
      sanitizeMixedProviderHistory(payload, {
        target: "anthropic",
        sourceModel: "anthropic.claude-haiku-4-5",
      }),
    ).toBe(payload);
  });

  it("keeps a child's own reasoning when a later follow-up adds another NEW_TASK", () => {
    const own = { type: "reasoning", encrypted_content: "gAAAA-child" };
    const followup = {
      ...task,
      content: [{ type: "input_text", text: "Message Type: NEW_TASK\nPayload:\nFollow up" }],
    };
    const sanitized = sanitizeMixedProviderHistory(
      {
        model: "gpt-5.6-luna",
        input: [{ type: "reasoning", encrypted_content: "acta1:parent" }, task, own, followup],
      },
      { target: "native", sourceModel: "anthropic.claude-haiku-4-5" },
    );
    expect(sanitized.input).toEqual([task, own, followup]);
  });

  it("refuses a foreign opaque compaction instead of losing its context", () => {
    expect(() =>
      sanitizeMixedProviderHistory(
        {
          model: "gpt-5.6-luna",
          input: [{ type: "compaction", encrypted_content: "acta1:sealed" }, task],
        },
        { target: "native", sourceModel: "anthropic.claude-haiku-4-5" },
      ),
    ).toThrow(ForeignHistoryError);
  });
});
