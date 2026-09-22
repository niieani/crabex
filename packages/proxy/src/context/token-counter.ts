import { countTokens } from "gpt-tokenizer/encoding/o200k_base";

const tokenCounts = new Map<string, number>();
const MAX_CACHED_CHARACTERS = 4_000_000;
let cachedCharacters = 0;

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
  const cached = tokenCounts.get(text);
  if (cached !== undefined) {
    tokenCounts.delete(text);
    tokenCounts.set(text, cached);
    return cached;
  }
  const count = countTokens(text);
  // Agent instructions and tool schemas recur across captures and previews.
  if (text.length > 0 && text.length <= MAX_CACHED_CHARACTERS) {
    while (cachedCharacters + text.length > MAX_CACHED_CHARACTERS || tokenCounts.size >= 2000) {
      const oldest = tokenCounts.keys().next().value!;
      tokenCounts.delete(oldest);
      cachedCharacters -= oldest.length;
    }
    tokenCounts.set(text, count);
    cachedCharacters += text.length;
  }
  return count;
}
