import { describe, expect, it } from "vite-plus/test";

import { parseCliOptions } from "./options.ts";

describe("parseCliOptions", () => {
  it("defaults to the ChatGPT backend origin", () => {
    expect(parseCliOptions(["proxy"])).toEqual({
      command: "proxy",
      host: "127.0.0.1",
      port: 8765,
      upstreamOrigin: "https://chatgpt.com",
      capturesDirectory: ".agent-context-trimmer/captures",
    });
  });

  it("parses explicit proxy settings", () => {
    expect(
      parseCliOptions([
        "proxy",
        "--listen",
        "0.0.0.0:9000",
        "--upstream",
        "http://127.0.0.1:8317",
        "--captures",
        "captures.local",
      ]),
    ).toEqual({
      command: "proxy",
      host: "0.0.0.0",
      port: 9000,
      upstreamOrigin: "http://127.0.0.1:8317",
      capturesDirectory: "captures.local",
    });
  });

  it("rejects unknown arguments", () => {
    expect(() => parseCliOptions(["proxy", "--mystery"])).toThrow("unknown argument: --mystery");
  });
});
