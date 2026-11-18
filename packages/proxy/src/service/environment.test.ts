import { describe, expect, it } from "vite-plus/test";
import { inheritServiceCaEnvironment, serviceEnvironmentValue } from "./environment.ts";
import { resolveCustomCaSource } from "./tls.ts";

describe("service CA environment", () => {
  const cwd = "/install";
  const shell = {
    SSL_CERT_FILE: "/certificates/proxy.pem",
    NODE_EXTRA_CA_CERTS: "./extra.pem",
    CODEX_CA_CERTIFICATE: "/certificates/codex.pem",
    UNRELATED_SECRET: "must-not-be-copied",
  };

  it("resolves inherited CA paths from the installer directory", () => {
    expect(inheritServiceCaEnvironment({}, undefined, shell, cwd)).toEqual({
      SSL_CERT_FILE: "/certificates/proxy.pem",
      NODE_EXTRA_CA_CERTS: "/install/extra.pem",
    });
  });

  it("preserves inherited values on upgrades and keeps them out of Codex CA precedence", () => {
    const environment = { HOME: "/home/example" };
    const inherited = inheritServiceCaEnvironment(environment, undefined, shell, cwd);
    const updateShell = { ...shell, SSL_CERT_FILE: "/certificates/new-proxy.pem" };

    expect(inheritServiceCaEnvironment(environment, inherited, updateShell, cwd)).toEqual(
      inherited,
    );
    expect(resolveCustomCaSource("/service/tls", [environment, updateShell])).toBe(
      shell.CODEX_CA_CERTIFICATE,
    );
  });

  it("lets explicit selections replace inherited values", () => {
    const previous = inheritServiceCaEnvironment({}, undefined, shell, cwd);
    const explicit = {
      SSL_CERT_FILE: serviceEnvironmentValue("SSL_CERT_FILE", "selected.pem", cwd),
    };

    expect(explicit.SSL_CERT_FILE).toBe("/install/selected.pem");
    expect(inheritServiceCaEnvironment(explicit, previous, shell, cwd)).toEqual({
      NODE_EXTRA_CA_CERTS: "/install/extra.pem",
    });
    expect(resolveCustomCaSource("/service/tls", [explicit, shell])).toBe(explicit.SSL_CERT_FILE);
    expect(serviceEnvironmentValue("MY_PROVIDER_TOKEN", "unchanged", cwd)).toBe("unchanged");
  });

  it("ignores missing and blank CA values", () => {
    expect(
      inheritServiceCaEnvironment(
        {},
        undefined,
        { SSL_CERT_FILE: "", NODE_EXTRA_CA_CERTS: " " },
        cwd,
      ),
    ).toEqual({});
    expect(inheritServiceCaEnvironment({}, undefined, {}, cwd)).toEqual({});
  });
});
