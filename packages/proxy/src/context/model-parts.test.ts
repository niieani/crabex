import { describe, expect, it } from "vite-plus/test";

import { modelStringFields, setModelField } from "./model-parts.ts";

describe("modelStringFields", () => {
  it("extracts string leaves under model_messages with dotted paths", () => {
    const fields = modelStringFields({
      slug: "gpt-5.6-luna",
      model_messages: {
        instructions_template: "You are Codex, an agent based on GPT-5. Be helpful.",
        instructions_variables: null,
        token_budget: {
          reminder_message_template: "<context_window_reminder> {n_remaining} left",
          guidance_message: "For tasks that may span context windows, use notes.",
          auto_compact_fallback_prompt: "",
          threshold: 0.9,
        },
      },
    });
    expect(fields.map((field) => field.dotPath)).toEqual([
      "model_messages.instructions_template",
      "model_messages.token_budget.reminder_message_template",
      "model_messages.token_budget.guidance_message",
    ]);
  });

  it("classifies recognized instruction content with segment identifiers", () => {
    const fields = modelStringFields({
      slug: "gpt-5.6-luna",
      model_messages: {
        instructions_template: "You are Codex, an agent based on GPT-5. Be helpful.",
      },
    });
    expect(fields[0]?.identifier).toBe("segment:codex_base");
    expect(fields[0]?.label).toBe("Codex base instructions");
    expect(fields[0]?.classificationId).toBe("segment:codex_base");
  });

  it("falls back to path-based identifiers for unrecognized strings", () => {
    const fields = modelStringFields({
      slug: "gpt-5.6-luna",
      model_messages: { token_budget: { guidance_message: "Use notes to checkpoint." } },
    });
    expect(fields[0]?.identifier).toBe("model:model_messages.token_budget.guidance_message");
    expect(fields[0]?.label).toBe("Guidance message");
    expect(fields[0]?.classificationId).toBeUndefined();
  });

  it("walks arrays of strings and nested objects", () => {
    const fields = modelStringFields({
      slug: "gpt-5.6-luna",
      model_messages: {
        prompts: ["First prompt.", { nested: "Nested prompt." }],
      },
    });
    expect(fields.map((field) => field.dotPath)).toEqual([
      "model_messages.prompts[0]",
      "model_messages.prompts[1].nested",
    ]);
  });

  it("includes mirrored top-level instruction fields after model_messages", () => {
    const fields = modelStringFields({
      slug: "gpt-5.6-luna",
      base_instructions: "You are Codex, an agent based on GPT-5. Be helpful.",
      description: "Fast model",
      model_messages: {
        instructions_template: "You are Codex, an agent based on GPT-5. Be helpful.",
      },
    });
    expect(fields.map((field) => field.dotPath)).toEqual([
      "model_messages.instructions_template",
      "base_instructions",
    ]);
    expect(fields[1]?.identifier).toBe("segment:codex_base");
  });

  it("returns nothing without a model_messages object", () => {
    expect(modelStringFields({ slug: "gpt-5.6-luna" })).toEqual([]);
    expect(modelStringFields({ slug: "gpt-5.6-luna", model_messages: null })).toEqual([]);
  });
});

describe("setModelField", () => {
  it("sets nested values in place", () => {
    const model = {
      slug: "gpt-5.6-luna",
      model_messages: { token_budget: { guidance_message: "before" } },
    };
    setModelField(model, ["model_messages", "token_budget", "guidance_message"], "after");
    expect(model.model_messages.token_budget.guidance_message).toBe("after");
  });
});
