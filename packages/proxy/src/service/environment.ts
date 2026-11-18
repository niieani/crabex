import { resolve } from "node:path";

const CA_ENVIRONMENT_NAMES = ["SSL_CERT_FILE", "NODE_EXTRA_CA_CERTS"] as const;

export function serviceEnvironmentValue(name: string, value: string, cwd: string): string {
  return CA_ENVIRONMENT_NAMES.some((caName) => caName === name) && value.trim() !== ""
    ? resolve(cwd, value)
    : value;
}

/** Keep inherited proxy trust separate from explicitly selected service variables. */
export function inheritServiceCaEnvironment(
  environment: Record<string, string>,
  previous: Record<string, string> | undefined,
  inherited: Record<string, string | undefined>,
  cwd: string,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const name of CA_ENVIRONMENT_NAMES) {
    const saved = previous?.[name];
    const value = inherited[name];
    if (environment[name] !== undefined) continue;
    if (saved !== undefined) {
      result[name] = saved;
    } else if (value !== undefined && value.trim() !== "") {
      result[name] = serviceEnvironmentValue(name, value, cwd);
    }
  }
  return result;
}
