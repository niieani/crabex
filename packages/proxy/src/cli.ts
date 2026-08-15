#!/usr/bin/env bun

import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { parseCliOptions } from "./cli/options.ts";
import { startReverseProxy } from "./proxy/server.ts";
import { openNdjsonCaptureSink } from "./recording/ndjson-capture-sink.ts";

const HELP = `Usage:
  agent-context-trimmer proxy [options]

Options:
  --listen <host:port>  Listener address (default: 127.0.0.1:8765)
  --upstream <origin>   Upstream origin (default: https://chatgpt.com)
  --captures <dir>      Capture directory (default: .agent-context-trimmer/captures)
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
  const proxy = await startReverseProxy({
    host: options.host,
    port: options.port,
    upstreamOrigin: options.upstreamOrigin,
    captureSink,
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
