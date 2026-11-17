const CA_ENVIRONMENT_NAMES = ["SSL_CERT_FILE", "NODE_EXTRA_CA_CERTS"] as const;

/** launchd does not inherit the installing shell's upstream TLS trust settings. */
export function inheritServiceCaEnvironment(
  environment: Record<string, string>,
  inherited: Record<string, string | undefined>,
): Record<string, string> {
  const result = { ...environment };
  for (const name of CA_ENVIRONMENT_NAMES) {
    const value = inherited[name];
    if (result[name] === undefined && value !== undefined && value.trim() !== "") {
      result[name] = value;
    }
  }
  return result;
}
