import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  args: process.argv.slice(2).filter((arg) => arg !== "--"),
  options: {
    version: { type: "string" },
    sha256: { type: "string" },
    output: { type: "string" },
  },
});
const { version, sha256, output } = values;
if (!version || !/^\d+\.\d+\.\d+(?:-[\dA-Za-z.-]+)?$/.test(version))
  throw new Error("Provide a semver --version");
if (!sha256 || !/^[a-f0-9]{64}$/.test(sha256)) throw new Error("Provide a lowercase --sha256");

const formula = `class Crabex < Formula
  desc "Route models and inspect context inside Codex"
  homepage "https://github.com/niieani/crabex"
  url "https://github.com/niieani/crabex/releases/download/v${version}/crabex-${version}.tgz"
  version "${version}"
  sha256 "${sha256}"
  license "MIT"

  depends_on "oven-sh/bun/bun"

  def install
    libexec.install "dist", "package.json", "LICENSE", "THIRD_PARTY_NOTICES.md", "THIRD_PARTY_LICENSES.txt"
    (bin/"crabex").write <<~SH
      #!/bin/sh
      exec "#{Formula["oven-sh/bun/bun"].opt_bin}/bun" "#{libexec}/dist/cli.mjs" "$@"
    SH
  end

  def caveats
    <<~EOS
      Run crabex proxy to start the proxy, or on macOS:
        crabex service install --https

      After brew upgrade, refresh an existing background service with:
        #{opt_bin}/crabex service install
      Inspect crabex service status and the reported worker log afterward.
    EOS
  end

  test do
    assert_equal version.to_s, shell_output("#{bin}/crabex --version").strip
    assert_match "crabex", shell_output("#{bin}/crabex --help")
  end
end
`;
if (output) {
  await mkdir(dirname(output), { recursive: true });
  await Bun.write(output, formula);
} else process.stdout.write(formula);
