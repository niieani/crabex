import { describe, expect, it } from "vite-plus/test";

import { defaultCodexConfigPath } from "../config/codex-config.ts";
import { parseCliOptions } from "./options.ts";

describe("parseCliOptions", () => {
  it("defaults to the ChatGPT backend origin", () => {
    expect(parseCliOptions(["proxy"])).toEqual({
      command: "proxy",
      host: "127.0.0.1",
      port: 8765,
      upstreamOrigin: "https://chatgpt.com",
      capturesDirectory: ".agent-context-trimmer/captures",
      transformationsPath: ".agent-context-trimmer/transformations.json",
      modelRoutesPath: ".agent-context-trimmer/model-routes.json",
      configBundlePath: ".agent-context-trimmer/config-bundle.json",
      codexConfigPath: defaultCodexConfigPath(),
      upstreamCachePath: ".agent-context-trimmer/upstream-cache.json",
      statsPath: ".agent-context-trimmer/stats.json",
      snapshotCachePath: ".agent-context-trimmer/snapshot-cache.json",
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
        "--transformations",
        "rules.local.json",
        "--model-routes",
        "routes.local.json",
        "--config-bundle",
        "bundle.local.json",
        "--codex-config",
        "codex.local.toml",
        "--upstream-cache",
        "upstream.local.json",
        "--stats",
        "stats.local.json",
        "--snapshot-cache",
        "snapshots.local.json",
        "--project",
        "fixture-project",
      ]),
    ).toEqual({
      command: "proxy",
      host: "0.0.0.0",
      port: 9000,
      upstreamOrigin: "http://127.0.0.1:8317",
      capturesDirectory: "captures.local",
      transformationsPath: "rules.local.json",
      modelRoutesPath: "routes.local.json",
      configBundlePath: "bundle.local.json",
      codexConfigPath: "codex.local.toml",
      upstreamCachePath: "upstream.local.json",
      statsPath: "stats.local.json",
      snapshotCachePath: "snapshots.local.json",
      project: "fixture-project",
    });
  });

  it("rejects unknown arguments", () => {
    expect(() => parseCliOptions(["proxy", "--mystery"])).toThrow("unknown argument: --mystery");
  });
});
