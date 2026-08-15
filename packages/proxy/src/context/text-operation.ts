import { RE2JS } from "re2js";

import type { TransformationOperation } from "./transformation.ts";

export function transformText(
  value: string,
  operation: Exclude<TransformationOperation, { type: "delete_part" }>,
): { value: string; matchCount: number } {
  if (operation.type === "replace") {
    const index = value.indexOf(operation.find);
    if (index === -1) return { value, matchCount: 0 };
    return {
      value:
        value.slice(0, index) + operation.replacement + value.slice(index + operation.find.length),
      matchCount: 1,
    };
  }
  if (operation.type === "replace_all") {
    if (operation.find === "") throw new Error("literal match cannot be empty");
    const matchCount = nonOverlappingCount(value, operation.find);
    return { value: value.replaceAll(operation.find, operation.replacement), matchCount };
  }

  const expression = RE2JS.compile(operation.pattern, re2Flags(operation.flags));
  const matcher = expression.matcher(value);
  let matchCount = 0;
  while (matcher.find()) matchCount += 1;
  if (matchCount === 0) return { value, matchCount };
  const replacementMatcher = expression.matcher(value);
  return {
    value: operation.replaceAll
      ? replacementMatcher.replaceAll(operation.replacement)
      : replacementMatcher.replaceFirst(operation.replacement),
    matchCount: operation.replaceAll ? matchCount : 1,
  };
}

function re2Flags(flags: string): number {
  let result = 0;
  for (const flag of flags) {
    if (flag === "i") result |= RE2JS.CASE_INSENSITIVE;
    else if (flag === "m") result |= RE2JS.MULTILINE;
    else if (flag === "s") result |= RE2JS.DOTALL;
    else throw new Error(`unsupported regular expression flag: ${flag}`);
  }
  return result;
}

function nonOverlappingCount(value: string, search: string): number {
  let count = 0;
  let offset = 0;
  while (true) {
    const index = value.indexOf(search, offset);
    if (index === -1) return count;
    count += 1;
    offset = index + search.length;
  }
}
