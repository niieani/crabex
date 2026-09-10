#!/usr/bin/env bun

import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { parseCliOptions } from "./cli/options.ts";
import { createLocalApi } from "./api/local-api.ts";
import { createCodexConfigManager } from "./config/codex-config.ts";
import { openConfigBundleStore } from "./config/config-bundle-store.ts";
import { openModelRouteStore } from "./config/model-route-store.ts";
import { openTransformationStore } from "./config/transformation-store.ts";
import { startReverseProxy } from "./proxy/server.ts";
import { modelRouteFromConfig } from "./routing/model-routes.ts";
import { FileCaptureRepository } from "./recording/capture-repository.ts";
import { openNdjsonCaptureSink } from "./recording/ndjson-capture-sink.ts";

const HELP = `Usage:
  agent-context-trimmer proxy [options]

Options:
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
  --project <key>       Optional project scope for captures and transformations
`;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(HELP);
    return;
  }

  const options = parseCliOptions(args);
  const capturePath = join(options.capturesDirectory, captureFileName());
  const captureSink = await openNdjsonCaptureSink(capturePath);
  const transformationStore = await openTransformationStore(options.transformationsPath);
  const modelRouteStore = await openModelRouteStore(options.modelRoutesPath);
  const configBundleStore = await openConfigBundleStore(options.configBundlePath);
  const proxyOrigin = `http://${
    options.host === "0.0.0.0" || options.host === "::" ? "127.0.0.1" : options.host
  }:${options.port}`;
  const proxy = await startReverseProxy({
    host: options.host,
    port: options.port,
    upstreamOrigin: options.upstreamOrigin,
    captureSink,
    transformationSource: { get: () => transformationStore.get().transformations },
    modelRouteSource: { get: () => modelRouteStore.get().map(modelRouteFromConfig) },
    configBundleSource: { get: () => configBundleStore.get() },
    project: options.project,
    localApi: createLocalApi({
      snapshots: new FileCaptureRepository(options.capturesDirectory),
      transformations: transformationStore,
      modelRoutes: modelRouteStore,
      configBundle: configBundleStore,
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
