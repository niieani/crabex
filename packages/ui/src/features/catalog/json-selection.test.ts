import { describe, expect, it } from "vite-plus/test";

import { resolveJsonStringSelection } from "./json-selection.ts";

describe("resolveJsonStringSelection", () => {
  it("maps escaped multiline source text to a decoded string and exact array path", () => {
    const source = JSON.stringify(
      { parameters: { variants: [{ description: "First line\nSecond line" }] } },
      null,
      2,
    );
    const raw = "First line\\nSecond line";
    const start = source.indexOf(raw);

    expect(
      resolveJsonStringSelection(source, source, offsets(source, start, start + raw.length)),
    ).toEqual({
      find: "First line\nSecond line",
      jsonPath: ["parameters", "variants", 0, "description"],
    });
  });

  it("rejects selections spanning JSON structure or absent from the actual value", () => {
    const displayed = '{\n  "description": "First line…",\n  "strict": true\n}';
    const actual = '{"description":"First line\\nSecond line","strict":true}';

    expect(
      resolveJsonStringSelection(displayed, actual, offsets(displayed, 0, displayed.length)),
    ).toBeUndefined();
    const ellipsis = displayed.indexOf("…");
    expect(
      resolveJsonStringSelection(displayed, actual, offsets(displayed, ellipsis, ellipsis + 1)),
    ).toBeUndefined();
  });
});

function offsets(source: string, start: number, end: number) {
  return { start: position(source, start), end: position(source, end) };
}

function position(source: string, offset: number) {
  const before = source.slice(0, offset).split("\n");
  return { line: before.length - 1, character: before.at(-1)!.length };
}
