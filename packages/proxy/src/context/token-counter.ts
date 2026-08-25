import { countTokens } from "gpt-tokenizer/encoding/o200k_base";

export function tokenizationForModel(model: string): {
  encoding: "o200k_base";
  fallback: boolean;
} {
  return {
    encoding: "o200k_base",
    fallback: model === "unknown",
  };
}

export function countTextTokens(text: string): number {
  return countTokens(text);
}
