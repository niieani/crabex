import { describe, expect, it } from "vite-plus/test";

import { modelStringFields } from "../context/model-parts.ts";
import { modelsFixture } from "./models-fixture.ts";

describe("modelsFixture", () => {
  it("loads the baked-in model catalog", () => {
    const slugs = modelsFixture().map((model) => model.slug);

    expect(slugs).toContain("gpt-6-astra");
    expect(slugs).toContain("gpt-5.6-terra");
    expect(slugs).toHaveLength(9);
  });

  it("exposes the astra model_messages strings as catalog fields", () => {
    const astra = modelsFixture().find((model) => model.slug === "gpt-6-astra");
    expect(astra).toBeDefined();

    const dotPaths = modelStringFields(astra!).map((field) => field.dotPath);

    expect(dotPaths).toContain("model_messages.instructions_template");
    expect(dotPaths).toContain("model_messages.persistent_instructions");
    expect(dotPaths).toContain("model_messages.approvals.on_request_auto_review");
    expect(dotPaths).toContain("model_messages.collaboration_modes.default");
    expect(dotPaths).toContain("model_messages.auto_review.rejection_instructions");
    expect(dotPaths).toContain("model_messages.multi_agent.role.root");
    expect(dotPaths).toContain("model_messages.multi_agent.role.subagent");
    expect(dotPaths).toContain("model_messages.guardian_v2.classifier_instructions");
    expect(dotPaths).toContain("model_messages.confirmation_policies.browser_use");
    expect(dotPaths).toContain("model_messages.confirmation_policies.computer_use");
    expect(dotPaths).toContain("model_messages.token_budget.guidance_message");
  });

  it("classifies the astra instructions template as the codex base segment", () => {
    const astra = modelsFixture().find((model) => model.slug === "gpt-6-astra");
    const field = modelStringFields(astra!).find(
      (item) => item.dotPath === "model_messages.instructions_template",
    );

    expect(field?.identifier).toBe("segment:codex_base");
  });
});
