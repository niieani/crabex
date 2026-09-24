import { describe, expect, it } from "vite-plus/test";
import { modelRouteFromConfig } from "../routing/model-routes.ts";
import {
  ForeignHistoryError,
  NATIVE_REASONING_FAMILY,
  routedReasoningFamily,
  sanitizeMixedProviderHistory,
} from "./mixed-provider-history.ts";

const fireworks = "responses:fireworks";
const anthropic = "anthropic:haiku";

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
      targetFamily: NATIVE_REASONING_FAMILY,
      sourceFamily: anthropic,
    });
    expect(sanitized.input).toEqual([text("Public answer"), task, own]);
    expect(payload.input).toHaveLength(5);
  });

  it("drops native ciphertext on a routed Responses fork and preserves its own plain reasoning", () => {
    const foreign = { type: "reasoning", id: "native", encrypted_content: "gAAAA-native" };
    const own = { type: "reasoning", id: "fireworks", summary: [{ text: "Safe summary" }] };
    const sanitized = sanitizeMixedProviderHistory(
      { model: "glm-5.3-flash", input: [foreign, task, own] },
      { target: "responses", targetFamily: fireworks, sourceFamily: NATIVE_REASONING_FAMILY },
    );
    expect(sanitized.input).toEqual([task, own]);
  });

  it("keeps opaque reasoning on Responses when parent provenance was lost", () => {
    const own = { type: "reasoning", summary: [{ text: "Plain provider summary" }] };
    const unknown = { type: "reasoning", encrypted_content: "gAAAA-unknown" };
    const sanitized = sanitizeMixedProviderHistory(
      {
        model: "glm-5.3-flash",
        input: [unknown, task, own],
      },
      { target: "responses", targetFamily: fireworks },
    );
    expect(sanitized.input).toEqual([unknown, task, own]);
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
      { target: "anthropic", targetFamily: anthropic, sourceFamily: fireworks },
    );
    expect(sanitized.input).toEqual([task, own]);
  });

  it("keeps same-model fork and ordinary replay reasoning unchanged", () => {
    const own = { type: "reasoning", encrypted_content: "acta1:own" };
    const payload = { model: "anthropic.claude-haiku-4-5", input: [own, task] };
    expect(
      sanitizeMixedProviderHistory(payload, {
        target: "anthropic",
        targetFamily: anthropic,
        sourceFamily: anthropic,
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
      { target: "native", targetFamily: NATIVE_REASONING_FAMILY, sourceFamily: anthropic },
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
        { target: "native", targetFamily: NATIVE_REASONING_FAMILY, sourceFamily: anthropic },
      ),
    ).toThrow(ForeignHistoryError);
  });

  it("keeps encrypted replay without a fork, and in a same-family fork between model names", () => {
    const own = { type: "reasoning", encrypted_content: "gAAAA-own" };
    const replay = { model: "gpt-5.6-luna", input: [own, text("Answer")] };
    expect(
      sanitizeMixedProviderHistory(replay, {
        target: "responses",
        targetFamily: "responses:openai-gateway",
      }),
    ).toBe(replay);
    const fork = { model: "gpt-5.6-luna", input: [own, task] };
    expect(
      sanitizeMixedProviderHistory(fork, {
        target: "native",
        targetFamily: NATIVE_REASONING_FAMILY,
        sourceFamily: NATIVE_REASONING_FAMILY,
      }),
    ).toBe(fork);
  });

  it("drops acta1 reasoning on native without lineage, but keeps other opaque items", () => {
    const own = { type: "reasoning", encrypted_content: "gAAAA-native" };
    const payload = {
      model: "gpt-5.6-luna",
      input: [{ type: "reasoning", encrypted_content: "acta1:sealed" }, own],
    };
    expect(sanitizeMixedProviderHistory(payload, { target: "native" }).input).toEqual([own]);
  });

  it("does not refuse opaque compaction without proven foreign provenance", () => {
    const compaction = { type: "compaction", encrypted_content: "gAAAA-own" };
    const payload = { model: "gpt-5.6-luna", input: [compaction, task] };
    expect(
      sanitizeMixedProviderHistory(payload, {
        target: "native",
        targetFamily: NATIVE_REASONING_FAMILY,
        sourceFamily: NATIVE_REASONING_FAMILY,
      }),
    ).toBe(payload);
    expect(
      sanitizeMixedProviderHistory(payload, {
        target: "responses",
        targetFamily: "responses:openai-gateway",
      }),
    ).toBe(payload);
    expect(() =>
      sanitizeMixedProviderHistory(payload, {
        target: "native",
        targetFamily: NATIVE_REASONING_FAMILY,
        sourceFamily: fireworks,
      }),
    ).toThrow(ForeignHistoryError);
  });

  it("groups routed Responses by upstream and credential, and Anthropic by envelope scope", () => {
    const config = {
      authorization_env: "ROUTE_TOKEN",
      upstream: "https://gateway.example/v1",
      model: {
        slug: "glm-5.3-flash",
        display_name: "GLM Flash",
        description: "Test",
        priority: 1,
        template_slug: "gpt-5.6-luna",
      },
    };
    const first = modelRouteFromConfig(config);
    const second = modelRouteFromConfig({
      ...config,
      model: { ...config.model, slug: "glm-5.3" },
    });
    const key = new Uint8Array(32).fill(7);
    const env = { ROUTE_TOKEN: "credential-a" };
    const family = routedReasoningFamily(first, env, key);
    expect(family).toBe(routedReasoningFamily(second, env, key));
    expect(family).not.toContain("credential-a");
    expect(routedReasoningFamily(first, {}, key)).toBeUndefined();
    expect(routedReasoningFamily(first, env, key)).not.toBe(
      routedReasoningFamily(first, { ROUTE_TOKEN: "credential-b" }, key),
    );
    expect(routedReasoningFamily(first, env, key)).not.toBe(
      routedReasoningFamily(
        modelRouteFromConfig({ ...config, upstream: "https://other.example/v1" }),
        env,
        key,
      ),
    );
    const anth = modelRouteFromConfig({ ...config, api: "anthropic-messages" });
    expect(routedReasoningFamily(anth, env, key)).not.toBe(
      routedReasoningFamily(anth, env, new Uint8Array(32).fill(8)),
    );
    expect(routedReasoningFamily(anth, env, key)).not.toBe(
      routedReasoningFamily(
        modelRouteFromConfig({
          ...config,
          api: "anthropic-messages",
          model: { ...config.model, slug: "claude-other" },
        }),
        env,
        key,
      ),
    );
  });
});
