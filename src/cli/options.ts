export interface ProxyCliOptions {
  command: "proxy";
  host: string;
  port: number;
  upstreamOrigin: string;
  capturesDirectory: string;
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
