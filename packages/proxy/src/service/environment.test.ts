import { describe, expect, it } from "vite-plus/test";
import { inheritServiceCaEnvironment } from "./environment.ts";

describe("service CA environment", () => {
  it("persists the installing shell's upstream CA settings in the LaunchAgent", () => {
    expect(
      inheritServiceCaEnvironment(
        { HOME: "/home/example" },
        {
          SSL_CERT_FILE: "/certificates/roots.pem",
          NODE_EXTRA_CA_CERTS: "/certificates/extra.pem",
          UNRELATED_SECRET: "must-not-be-copied",
          CODEX_CA_CERTIFICATE: "/managed/codex-ca-bundle.pem",
        },
      ),
    ).toEqual({
      HOME: "/home/example",
      SSL_CERT_FILE: "/certificates/roots.pem",
      NODE_EXTRA_CA_CERTS: "/certificates/extra.pem",
    });
  });
  it("preserves selected values on updates without mutating existing state", () => {
    const previous = { SSL_CERT_FILE: "/certificates/selected.pem", MY_PROVIDER_TOKEN: "example" };
    const result = inheritServiceCaEnvironment(previous, {
      SSL_CERT_FILE: "/certificates/other.pem",
      NODE_EXTRA_CA_CERTS: "/certificates/extra.pem",
    });
    expect(result).toEqual({ ...previous, NODE_EXTRA_CA_CERTS: "/certificates/extra.pem" });
    expect(previous).toEqual({
      SSL_CERT_FILE: "/certificates/selected.pem",
      MY_PROVIDER_TOKEN: "example",
    });
  });
  it("ignores missing and blank CA values", () => {
    expect(
      inheritServiceCaEnvironment({}, { SSL_CERT_FILE: "", NODE_EXTRA_CA_CERTS: " " }),
    ).toEqual({});
    expect(inheritServiceCaEnvironment({}, {})).toEqual({});
  });
});
