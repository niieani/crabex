#!/usr/bin/env bun

import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { parseCliOptions } from "./cli/options.ts";
import { createLocalApi } from "./api/local-api.ts";
import { createCodexConfigManager } from "./config/codex-config.ts";
import { openProxyConfigStore } from "./config/proxy-config-store.ts";
import { openConfigBundleStore } from "./config/config-bundle-store.ts";
import { openModelRouteStore } from "./config/model-route-store.ts";
import { openTransformationStore } from "./config/transformation-store.ts";
import { openUpstreamCacheStore } from "./config/upstream-cache.ts";
import { startReverseProxy } from "./proxy/server.ts";
import { TargetBreakers } from "./routing/failover.ts";
import { modelRouteFromConfig } from "./routing/model-routes.ts";
import { FileCaptureRepository } from "./recording/capture-repository.ts";
import { openNdjsonCaptureSink } from "./recording/ndjson-capture-sink.ts";
import { StatsStore } from "./recording/stats-store.ts";
import { LiveRequestStore } from "./requests/live-request-store.ts";

const HELP = `Usage:
  agent-context-trimmer proxy [options]

Options:
  --config <file>      Proxy settings (default: .agent-context-trimmer/config.json)
  --no-apps-auth-relay Disable Apps credential reuse (enabled by default)
  --apps-auth-relay    Override config to enable Apps credential reuse
  --listen <host:port>  Listener address (default: 127.0.0.1:8765)
  --upstream <origin>   Upstream origin (default: https://chatgpt.com)
  --captures <dir>      Capture directory (default: .agent-context-trimmer/captures)
  --transformations <file>
                        Transformation set (default: .agent-context-trimmer/transformations.json)
  --model-routes <file> Model route set (default: .agent-context-trimmer/model-routes.json)
  --config-bundle <file>
                        Config bundle override (default: .agent-context-trimmer/config-bundle.json)
  --codex-config <file> Codex config for UI toggles (default: $CODEX_HOME/config.toml or
                        ~/.codex/config.toml)
  --upstream-cache <file>
                        Last observed upstream models/bundle responses
                        (default: .agent-context-trimmer/upstream-cache.json)
  --stats <file>        Persisted telemetry counters
                        (default: .agent-context-trimmer/stats.json)
  --snapshot-cache <file>
                        Context snapshot disk cache
                        (default: .agent-context-trimmer/snapshot-cache.json)
  --project <key>       Optional project scope for captures and transformations
`;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(HELP);
    return;
  }

  const options = parseCliOptions(args);
  const proxyConfig = await openProxyConfigStore(options.configPath);
  const capturePath = join(options.capturesDirectory, captureFileName());
  const captureSink = await openNdjsonCaptureSink(capturePath);
  const transformationStore = await openTransformationStore(options.transformationsPath);
  const modelRouteStore = await openModelRouteStore(options.modelRoutesPath);
  const configBundleStore = await openConfigBundleStore(options.configBundlePath);
  const upstreamCacheStore = await openUpstreamCacheStore(options.upstreamCachePath);
  const statsStore = await StatsStore.open(options.statsPath);
  const snapshotRepository = new FileCaptureRepository(
    options.capturesDirectory,
    {
      upstreamCache: upstreamCacheStore,
      modelRoutes: modelRouteStore,
      transformations: transformationStore,
    },
    { path: options.snapshotCachePath },
  );
  await snapshotRepository.load();
  const targetBreakers = new TargetBreakers();
  const liveRequests = new LiveRequestStore();
  const proxyOrigin = `http://${
    options.host === "0.0.0.0" || options.host === "::" ? "127.0.0.1" : options.host
  }:${options.port}`;
  const proxy = await startReverseProxy({
    host: options.host,
    appsAuthRelay: options.appsAuthRelay,
    proxyConfigSource: proxyConfig,
    port: options.port,
    upstreamOrigin: options.upstreamOrigin,
    captureSink,
    transformationSource: { get: () => transformationStore.get().transformations },
    modelRouteSource: {
      get: () => {
        const set = modelRouteStore.get();
        return {
          routes: set.routes.map(modelRouteFromConfig),
          adjustments: set.adjustments,
          fixturePins: set.fixture_pins,
        };
      },
    },
    configBundleSource: { get: () => configBundleStore.get() },
    upstreamCache: upstreamCacheStore,
    breakers: targetBreakers,
    stats: statsStore,
    liveRequests,
    project: options.project,
    localApi: createLocalApi({
      proxyConfig,
      appsAuthRelayOverride: options.appsAuthRelay,
      allowAppsAuthRelay: ["127.0.0.1", "::1", "localhost"].includes(options.host),
      snapshots: snapshotRepository,
      transformations: transformationStore,
      modelRoutes: modelRouteStore,
      configBundle: configBundleStore,
      upstreamCache: upstreamCacheStore,
      breakers: targetBreakers,
      stats: statsStore,
      requests: liveRequests,
      codexConfig: createCodexConfigManager({
        configPath: options.codexConfigPath,
        proxyOrigin,
      }),
    }),
  });

  process.stdout.write(`listening ${proxy.origin}\ncapturing ${capturePath}\n`);
  await waitForShutdownSignal();
  await proxy.close();
  await captureSink.close();
  await statsStore.flush();
  await snapshotRepository.flush();
}

function captureFileName(): string {
  const timestamp = new Date().toISOString().replaceAll(":", "-");
  return `${timestamp}-${randomUUID()}.ndjson`;
}

function waitForShutdownSignal(): Promise<void> {
  return new Promise((resolve) => {
    const shutdown = () => {
      process.off("SIGINT", shutdown);
      process.off("SIGTERM", shutdown);
      resolve();
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
