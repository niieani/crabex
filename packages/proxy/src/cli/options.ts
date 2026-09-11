import { defaultCodexConfigPath } from "../config/codex-config.ts";

export interface ProxyCliOptions {
  command: "proxy";
  host: string;
  port: number;
  upstreamOrigin: string;
  capturesDirectory: string;
  transformationsPath: string;
  modelRoutesPath: string;
  configBundlePath: string;
  codexConfigPath: string;
  upstreamCachePath: string;
  statsPath: string;
  snapshotCachePath: string;
  project?: string;
}

export function parseCliOptions(args: string[]): ProxyCliOptions {
  if (args[0] !== "proxy") {
    throw new Error(`expected command: proxy`);
  }

  const options: ProxyCliOptions = {
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
  };

  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index];
    const value = args[index + 1];
    if (argument === undefined) break;
    if (argument === "--listen") {
      if (value === undefined) throw new Error("missing value for --listen");
      const listen = parseListen(value);
      options.host = listen.host;
      options.port = listen.port;
      index += 1;
    } else if (argument === "--upstream") {
      if (value === undefined) throw new Error("missing value for --upstream");
      options.upstreamOrigin = value;
      index += 1;
    } else if (argument === "--captures") {
      if (value === undefined) throw new Error("missing value for --captures");
      options.capturesDirectory = value;
      index += 1;
    } else if (argument === "--transformations") {
      if (value === undefined) throw new Error("missing value for --transformations");
      options.transformationsPath = value;
      index += 1;
    } else if (argument === "--model-routes") {
      if (value === undefined) throw new Error("missing value for --model-routes");
      options.modelRoutesPath = value;
      index += 1;
    } else if (argument === "--config-bundle") {
      if (value === undefined) throw new Error("missing value for --config-bundle");
      options.configBundlePath = value;
      index += 1;
    } else if (argument === "--codex-config") {
      if (value === undefined) throw new Error("missing value for --codex-config");
      options.codexConfigPath = value;
      index += 1;
    } else if (argument === "--upstream-cache") {
      if (value === undefined) throw new Error("missing value for --upstream-cache");
      options.upstreamCachePath = value;
      index += 1;
    } else if (argument === "--stats") {
      if (value === undefined) throw new Error("missing value for --stats");
      options.statsPath = value;
      index += 1;
    } else if (argument === "--snapshot-cache") {
      if (value === undefined) throw new Error("missing value for --snapshot-cache");
      options.snapshotCachePath = value;
      index += 1;
    } else if (argument === "--project") {
      if (value === undefined) throw new Error("missing value for --project");
      options.project = value;
      index += 1;
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }

  return options;
}

function parseListen(value: string): { host: string; port: number } {
  let parsed: URL;
  try {
    parsed = new URL(`http://${value}`);
  } catch {
    throw new Error(`invalid --listen value: ${value}`);
  }
  const port = Number(parsed.port);
  if (
    parsed.pathname !== "/" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    !Number.isInteger(port) ||
    port < 0 ||
    port > 65535
  ) {
    throw new Error(`invalid --listen value: ${value}`);
  }
  return { host: parsed.hostname.replace(/^\[|\]$/g, ""), port };
}
