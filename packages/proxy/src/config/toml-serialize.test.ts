import { parse } from "smol-toml";
import { describe, expect, it } from "vite-plus/test";
import { serializeToml } from "./toml-serialize.ts";

describe("TOML serialization", () => {
  it("round trips strings, arrays, scalars, nested tables and quoted keys", () => {
    const value = {
      text: 'quotes " and backslash \\ and newline\n tabs\t control \u0000\u007f, unicode 🦀',
      enabled: false,
      integer: 42,
      fractional: 0.25,
      list: ["one", "two", 3, true, ["nested"], { "dotted.key": "value" }],
      "a.b": { 'quoted"key': { empty: {}, contents: "" } },
    };
    expect(parse(serializeToml(value))).toEqual(value);
  });
  it.each([null, undefined, NaN, Infinity])("rejects unsupported values (%s)", (value) => {
    expect(() => serializeToml({ value })).toThrow("unsupported TOML value");
  });
});
