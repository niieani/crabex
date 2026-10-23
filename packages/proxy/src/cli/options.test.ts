import { describe, expect, it } from "vite-plus/test";

import { defaultCodexConfigPath } from "../config/codex-config.ts";
import { parseCliOptions } from "./options.ts";

describe("parseCliOptions", () => {
  it("defaults to the ChatGPT backend origin", () => {
    expect(parseCliOptions(["proxy"])).toEqual({
      command: "proxy",
      configPath: ".crabex/config.json",
      host: "127.0.0.1",
      port: 8765,
      upstreamOrigin: "https://chatgpt.com",
      capturesDirectory: ".crabex/captures",
      captureRetentionDays: 7,
      captureMaxBytes: 2048 * 1024 * 1024,
      transformationsPath: ".crabex/transformations.json",
      modelRoutesPath: ".crabex/model-routes.json",
      configBundlePath: ".crabex/config-bundle.json",
      codexConfigPath: defaultCodexConfigPath(),
      upstreamCachePath: ".crabex/upstream-cache.json",
      statsPath: ".crabex/stats.json",
      snapshotCachePath: ".crabex/snapshot-cache.json",
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
        "--capture-retention-days",
        "30",
        "--capture-max-mb",
        "512",
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
      configPath: ".crabex/config.json",
      host: "0.0.0.0",
      port: 9000,
      upstreamOrigin: "http://127.0.0.1:8317",
      capturesDirectory: "captures.local",
      captureRetentionDays: 30,
      captureMaxBytes: 512 * 1024 * 1024,
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

  it("rejects non-positive capture limits", () => {
    expect(() => parseCliOptions(["proxy", "--capture-retention-days", "0"])).toThrow(
      "invalid --capture-retention-days value: 0",
    );
  });

  it("rejects unknown arguments", () => {
    expect(() => parseCliOptions(["proxy", "--mystery"])).toThrow("unknown argument: --mystery");
  });

  it("enables the single-account Apps authentication relay explicitly", () => {
    expect(
      parseCliOptions(["proxy", "--apps-auth-relay", "--listen", "127.0.0.1:9000"]),
    ).toMatchObject({ appsAuthRelay: true, port: 9000 });
  });

  it("accepts a proxy config file and an explicit relay opt-out", () => {
    expect(
      parseCliOptions(["proxy", "--config", "settings.json", "--no-apps-auth-relay"]),
    ).toMatchObject({ configPath: "settings.json", appsAuthRelay: false });
  });

  it("requires TLS when asked to publish a Codex CA bundle", () => {
    expect(() => parseCliOptions(["proxy", "--codex-ca-bundle", "combined.pem"])).toThrow(
      "--codex-ca-bundle requires --tls-dir",
    );
    expect(
      parseCliOptions(["proxy", "--tls-dir", "tls", "--codex-ca-bundle", "combined.pem"]),
    ).toMatchObject({ tlsDirectory: "tls", codexCaBundlePath: "combined.pem" });
  });
});
