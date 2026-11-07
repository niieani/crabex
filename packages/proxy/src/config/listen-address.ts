export function parseListen(value: string, label = "--listen"): { host: string; port: number } {
  let parsed: URL;
  try {
    parsed = new URL(`http://${value}`);
  } catch {
    throw new Error(`invalid ${label} value: ${value}`);
  }
  const explicitPort = /:(\d+)$/.exec(value)?.[1];
  const port = Number(explicitPort);
  if (
    explicitPort === undefined ||
    parsed.pathname !== "/" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    !Number.isInteger(port) ||
    port < 0 ||
    port > 65535
  ) {
    throw new Error(`invalid ${label} value: ${value}`);
  }
  return { host: parsed.hostname.replace(/^\[|\]$/g, ""), port };
}
