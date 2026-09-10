import { describe, expect, it } from "vite-plus/test";

import type { ContextPart } from "../../lib/types.ts";
import { collapseModelTwins } from "./collapse-model-twins.ts";

function part(overrides: Partial<ContextPart>): ContextPart {
  return {
    id: "part",
    phase: "inference",
    kind: "message",
    name: "Part",
    path: "input[0].content[0].text",
    text: "text",
    characters: 4,
    estimatedTokens: 1,
    digest: "digest",
    ...overrides,
  };
}

describe("collapseModelTwins", () => {
  it("folds identical request parts into the model part", () => {
    const model = part({
      id: "model-1",
      phase: "model",
      path: "model_messages.instructions_template",
      identifier: "segment:codex_base",
      text: "You are Codex, an agent.",
    });
    const prewarm = part({
      id: "prewarm-1",
      phase: "prewarm",
      identifier: "segment:codex_base",
      text: "You are Codex, an agent.",
    });
    const inference = part({
      id: "inference-1",
      identifier: "segment:codex_base",
      text: "You are Codex, an agent.",
    });
    const user = part({ id: "user-1", text: "hi" });

    const { parts, twins } = collapseModelTwins([prewarm, inference, user, model]);

    expect(parts).toEqual([user, model]);
    expect(twins.get(model)).toEqual([prewarm, inference]);
  });

  it("keeps both when the effective text diverges", () => {
    const model = part({
      id: "model-1",
      phase: "model",
      identifier: "segment:codex_base",
      text: "You are Codex, an edited agent.",
      originalText: "You are Codex, an agent.",
    });
    const inference = part({
      id: "inference-1",
      identifier: "segment:codex_base",
      text: "You are Codex, an agent.",
    });

    const { parts, twins } = collapseModelTwins([inference, model]);

    expect(parts).toEqual([inference, model]);
    expect(twins.size).toBe(0);
  });

  it("keeps both when only the originals diverge", () => {
    const model = part({
      id: "model-1",
      phase: "model",
      identifier: "segment:codex_base",
      text: "edited",
      originalText: "template original",
    });
    const inference = part({
      id: "inference-1",
      identifier: "segment:codex_base",
      text: "edited",
      originalText: "rendered original",
    });

    const { parts } = collapseModelTwins([inference, model]);

    expect(parts).toHaveLength(2);
  });

  it("collapses parts deleted identically at both layers", () => {
    const model = part({
      id: "model-1",
      phase: "model",
      identifier: "segment:codex_base",
      text: "",
      originalText: "You are Codex, an agent.",
      deleted: true,
    });
    const inference = part({
      id: "inference-1",
      identifier: "segment:codex_base",
      text: "",
      originalText: "You are Codex, an agent.",
      deleted: true,
    });

    const { parts, twins } = collapseModelTwins([inference, model]);

    expect(parts).toEqual([model]);
    expect(twins.get(model)).toEqual([inference]);
  });

  it("ignores model parts without identifiers", () => {
    const model = part({ id: "model-1", phase: "model", text: "same" });
    const inference = part({ id: "inference-1", text: "same" });

    const { parts, twins } = collapseModelTwins([inference, model]);

    expect(parts).toHaveLength(2);
    expect(twins.size).toBe(0);
  });
});
