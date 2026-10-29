#!/usr/bin/env bun
import { version } from "../package.json";
import {
  codexHomeForWorkaround,
  createBrowserWorkaroundSource,
} from "./config/browser-workaround.ts";

import { dirname } from "node:path";

import { parseCliOptions } from "./cli/options.ts";
import { readTls, syncProxyStartupCodexCa, tlsStatus } from "./service/tls.ts";
import { serviceCommand } from "./service/launch-agent.ts";
import { createLocalApi } from "./api/local-api.ts";
import { createWebUi, findUiDirectory } from "./api/web-ui.ts";
import { createCodexConfigManager, migrateCodexConfigFile } from "./config/codex-config.ts";
import { migrateLocalDataDirectory } from "./config/legacy-migration.ts";
import { openProxyConfigStore } from "./config/proxy-config-store.ts";
import { gateConfigBundleOverride, openConfigBundleStore } from "./config/config-bundle-store.ts";
import { openModelRouteStore } from "./config/model-route-store.ts";
import { openTransformationStore } from "./config/transformation-store.ts";
import { openUpstreamCacheStore } from "./config/upstream-cache.ts";
import { startReverseProxy } from "./proxy/server.ts";
import { TargetBreakers } from "./routing/failover.ts";
import { openAnthropicKey } from "./proxy/anthropic/envelope.ts";
import { modelRouteFromConfig } from "./routing/model-routes.ts";
import { FileCaptureRepository } from "./recording/capture-repository.ts";
import { openRotatingCaptureSink } from "./recording/ndjson-capture-sink.ts";
import { StatsStore } from "./recording/stats-store.ts";
import { LiveRequestStore } from "./requests/live-request-store.ts";

const HELP = `Crabex - any model, living in Codex's shell

Usage:
  crabex proxy [options]
  crabex service install [--https] [--env NAME]... [-- proxy options]
  crabex service uninstall|status|restart|logs
  crabex service tls status|renew|remove

Service commands install a macOS LaunchAgent that starts at login. Install/update
and restart use an independent worker; inspect service status/logs for completion.

Options:
  --version, -v        Print the package version
  --help, -h           Print this help
  --tls-dir <dir>      HTTPS certificate directory (cert.pem, key.pem, ca.pem)
  --config <file>      Proxy settings (default: .crabex/config.json)
  --no-apps-auth-relay Disable Apps credential reuse (enabled by default)
  --apps-auth-relay    Override config to enable Apps credential reuse
  --listen <host:port>  Listener address (default: 127.0.0.1:8765)
  --upstream <origin>   Upstream origin (default: https://chatgpt.com)
  --captures <dir>      Capture directory (default: .crabex/captures)
  --capture-retention-days <n>
                        Delete capture files older than n days (default: 7)
  --capture-max-mb <n>  Delete oldest captures beyond n MiB in total (default: 2048)
  --transformations <file>
                        Transformation set (default: .crabex/transformations.json)
  --model-routes <file> Model route set (default: .crabex/model-routes.json)
  --config-bundle <file>
                        Config bundle override (default: .crabex/config-bundle.json)
  --codex-config <file> Codex config for UI toggles (default: $CODEX_HOME/config.toml or
                        ~/.codex/config.toml)
  --upstream-cache <file>
                        Last observed upstream models/bundle responses
                        (default: .crabex/upstream-cache.json)
  --stats <file>        Persisted telemetry counters
                        (default: .crabex/stats.json)
  --snapshot-cache <file>
                        Context snapshot disk cache
                        (default: .crabex/snapshot-cache.json)
  --project <key>       Optional project scope for captures and transformations
`;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--version") || args.includes("-v")) {
    console.log(version);
    return;
  }
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(HELP);
    return;
  }

  if (args[0] !== "service" || args[1] === "install")
    reportMigration(await migrateLocalDataDirectory());
  if (args[0] === "service") {
    await serviceCommand(args.slice(1));
    return;
  }
  const options = parseCliOptions(args);
  reportMigration(await migrateCodexConfigFile(options.codexConfigPath));
  if (options.codexCaBundlePath !== undefined) {
    try {
      syncProxyStartupCodexCa({ path: options.codexCaBundlePath });
    } catch (error) {
      // A user may deliberately replace this value after installation. Keep the
      // proxy available and leave that explicit choice untouched.
      console.error(
        `Could not publish the managed CODEX_CA_CERTIFICATE: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  const proxyConfig = await openProxyConfigStore(options.configPath);
  const captureSink = await openRotatingCaptureSink(options.capturesDirectory, {
    retention: { maxAgeDays: options.captureRetentionDays, maxTotalBytes: options.captureMaxBytes },
  });
  const transformationStore = await openTransformationStore(options.transformationsPath);
  const upstreamCacheStore = await openUpstreamCacheStore(options.upstreamCachePath);
  const modelRouteStore = await openModelRouteStore(
    options.modelRoutesPath,
    () => upstreamCacheStore.get().models?.body,
  );
  const configBundleStore = await openConfigBundleStore(options.configBundlePath);
  // Overrides saved before local_policy_override existed keep being served.
  if (configBundleStore.get().enabled && !proxyConfig.get().local_policy_override) {
    await proxyConfig.replace({ ...proxyConfig.get(), local_policy_override: true });
    console.log(`Enabled local_policy_override in ${proxyConfig.path} for the saved local policy`);
  }
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
  const host = options.host === "0.0.0.0" || options.host === "::" ? "127.0.0.1" : options.host;
  const proxyOrigin = `${options.tlsDirectory ? "https" : "http"}://${host === "::1" ? "[::1]" : host}:${options.port}`;
  const browserWorkaround = createBrowserWorkaroundSource(
    codexHomeForWorkaround(options.codexConfigPath),
  );
  const proxy = await startReverseProxy({
    browserWorkaround,
    anthropicKey: await openAnthropicKey(`${options.modelRoutesPath}.anthropic-key`),
    webUi: createWebUi(await findUiDirectory(import.meta.dirname)),
    host: options.host,
    tls: options.tlsDirectory ? await readTls(options.tlsDirectory) : undefined,
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
    configBundleSource: {
      get: () =>
        gateConfigBundleOverride(configBundleStore.get(), proxyConfig.get().local_policy_override),
    },
    upstreamCache: upstreamCacheStore,
    sessionCacheDirectory: dirname(options.snapshotCachePath),
    breakers: targetBreakers,
    stats: statsStore,
    liveRequests,
    project: options.project,
    localApi: createLocalApi({
      browserWorkaround,
      proxyConfig,
      tlsStatus: () => tlsStatus(options.tlsDirectory),
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

  process.stdout.write(
    `Crabex UI & proxy: ${proxy.origin}\ncapturing to ${options.capturesDirectory} (kept ${options.captureRetentionDays} days, up to ${Math.round(options.captureMaxBytes / 1024 / 1024)} MiB)\n`,
  );
  await waitForShutdownSignal();
  await proxy.close();
  await captureSink.close();
  await statsStore.flush();
  await snapshotRepository.flush();
}

function reportMigration(notice: string | undefined): void {
  if (notice !== undefined) process.stderr.write(`${notice}\n`);
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
