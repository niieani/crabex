import { describe, expect, it } from "vite-plus/test";

import { countTextTokens, tokenizationForModel } from "./token-counter.ts";

describe("tokenCounterForModel", () => {
  const text = "お誕生日おめでとう";

  it("uses o200k_base for a captured Codex model", () => {
    expect(tokenizationForModel("gpt-5.6-luna")).toEqual({
      encoding: "o200k_base",
      fallback: false,
    });
    expect(countTextTokens(text)).toBe(8);
  });

  it("falls back explicitly to o200k_base when the snapshot model is unknown", () => {
    expect(tokenizationForModel("unknown")).toEqual({
      encoding: "o200k_base",
      fallback: true,
    });
    expect(countTextTokens(text)).toBe(8);
  });
});
