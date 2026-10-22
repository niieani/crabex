import { mkdtemp, readFile, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vite-plus/test";

import {
  applyCodexConfigToggle,
  codexConfigToggles,
  createCodexConfigManager,
  defaultCodexConfigPath,
} from "./codex-config.ts";

const MANAGED = "http://127.0.0.1:8765/backend-api/codex";
const KEY = "openai_base_url";

function effectiveValue(text: string): unknown {
  return (Bun.TOML.parse(text) as Record<string, unknown>)[KEY];
}

describe("applyCodexConfigToggle", () => {
  it("inserts a fenced managed setting at the top of an empty file", () => {
    const next = applyCodexConfigToggle("", KEY, MANAGED, true);

    expect(next).toBe(
      [`# >>> crabex:${KEY} >>>`, `${KEY} = "${MANAGED}"`, `# <<< crabex:${KEY} <<<`, ""].join(
        "\n",
      ),
    );
    expect(effectiveValue(next)).toBe(MANAGED);
  });

  it("comments out an existing user value inside the fence and restores it on disable", () => {
    const original = `model = "gpt-5.6"\n${KEY} = "https://api.openai.com/v1"\n`;
    const enabled = applyCodexConfigToggle(original, KEY, MANAGED, true);

    expect(enabled).toBe(
      [
        `model = "gpt-5.6"`,
        `# >>> crabex:${KEY} >>>`,
        `# ${KEY} = "https://api.openai.com/v1"`,
        `${KEY} = "${MANAGED}"`,
        `# <<< crabex:${KEY} <<<`,
        "",
      ].join("\n"),
    );
    expect(effectiveValue(enabled)).toBe(MANAGED);

    const disabled = applyCodexConfigToggle(enabled, KEY, MANAGED, false);
    expect(disabled).toBe(original);
    expect(effectiveValue(disabled)).toBe("https://api.openai.com/v1");
  });

  it("leaves section-scoped keys untouched and fences at the top", () => {
    const original = `model = "gpt-5.6"\n\n[profiles.work]\n${KEY} = "https://profile.example/v1"\n`;
    const enabled = applyCodexConfigToggle(original, KEY, MANAGED, true);

    expect(enabled.startsWith(`# >>> crabex:${KEY} >>>`)).toBe(true);
    expect(enabled).toContain(`[profiles.work]\n${KEY} = "https://profile.example/v1"`);
    const parsed = Bun.TOML.parse(enabled) as Record<string, unknown>;
    expect(parsed[KEY]).toBe(MANAGED);
    expect((parsed.profiles as Record<string, unknown>).work).toMatchObject({
      [KEY]: "https://profile.example/v1",
    });

    const disabled = applyCodexConfigToggle(enabled, KEY, MANAGED, false);
    expect(disabled).toBe(original);
  });

  it("is idempotent when enabled repeatedly", () => {
    const original = `${KEY} = "https://api.openai.com/v1"\n`;
    const once = applyCodexConfigToggle(original, KEY, MANAGED, true);
    const twice = applyCodexConfigToggle(once, KEY, MANAGED, true);
    expect(twice).toBe(once);
    expect(effectiveValue(twice)).toBe(MANAGED);
  });

  it("is a no-op when disabling without a fence", () => {
    const original = `model = "gpt-5.6"\n`;
    expect(applyCodexConfigToggle(original, KEY, MANAGED, false)).toBe(original);
  });

  it("rejects multiline user values instead of corrupting them", () => {
    const original = `${KEY} = """\nhttps://api.openai.com/v1\n"""\n`;
    expect(() => applyCodexConfigToggle(original, KEY, MANAGED, true)).toThrow("multiline string");
  });

  it("rejects an unclosed fence", () => {
    const broken = `# >>> crabex:${KEY} >>>\n${KEY} = "${MANAGED}"\n`;
    expect(() => applyCodexConfigToggle(broken, KEY, MANAGED, false)).toThrow(
      `unclosed crabex fence for ${KEY}`,
    );
  });
});

describe("createCodexConfigManager", () => {
  it("toggles settings on disk and reports state", async () => {
    const directory = await mkdtemp(join(tmpdir(), "act-codex-config-"));
    const configPath = join(directory, "config.toml");
    await Bun.write(configPath, `${KEY} = "https://api.openai.com/v1"\n`);
    const manager = createCodexConfigManager({
      configPath,
      proxyOrigin: "http://127.0.0.1:8765",
    });

    const initial = await manager.state();
    expect(initial.exists).toBe(true);
    expect(initial.toggles).toHaveLength(2);
    const responses = initial.toggles.find((toggle) => toggle.key === KEY)!;
    expect(responses.enabled).toBe(false);
    expect(responses.effectiveValue).toBe("https://api.openai.com/v1");
    expect(responses.managedValue).toBe("http://127.0.0.1:8765/backend-api/codex");

    const enabled = await manager.setEnabled(KEY, true);
    const enabledToggle = enabled.toggles.find((toggle) => toggle.key === KEY)!;
    expect(enabledToggle.enabled).toBe(true);
    expect(enabledToggle.preservedValue).toBe(`${KEY} = "https://api.openai.com/v1"`);

    const disabled = await manager.setEnabled(KEY, false);
    expect(disabled.toggles.find((toggle) => toggle.key === KEY)!.enabled).toBe(false);
    expect(await readFile(configPath, "utf8")).toBe(`${KEY} = "https://api.openai.com/v1"\n`);
  });

  it("creates a missing config file on enable", async () => {
    const directory = await mkdtemp(join(tmpdir(), "act-codex-config-"));
    const configPath = join(directory, "config.toml");
    const manager = createCodexConfigManager({
      configPath,
      proxyOrigin: "http://127.0.0.1:8765",
    });

    expect((await manager.state()).exists).toBe(false);
    const enabled = await manager.setEnabled("chatgpt_base_url", true);
    expect(enabled.exists).toBe(true);
    const toggle = enabled.toggles.find((item) => item.key === "chatgpt_base_url")!;
    expect(toggle.enabled).toBe(true);
    expect(toggle.managedValue).toBe("http://127.0.0.1:8765/backend-api");
    expect((await stat(configPath)).mode & 0o777).toBe(0o600);
  });

  it("rejects unsupported toggle keys", async () => {
    const directory = await mkdtemp(join(tmpdir(), "act-codex-config-"));
    const manager = createCodexConfigManager({
      configPath: join(directory, "config.toml"),
      proxyOrigin: "http://127.0.0.1:8765",
    });

    await expect(manager.setEnabled("model", true)).rejects.toThrow(
      "unsupported codex config toggle: model",
    );
  });
});

describe("codexConfigToggles", () => {
  it("derives managed values from the proxy origin", () => {
    expect(
      codexConfigToggles("http://127.0.0.1:9000").map((toggle) => toggle.managedValue),
    ).toEqual(["http://127.0.0.1:9000/backend-api/codex", "http://127.0.0.1:9000/backend-api"]);
  });
});

describe("defaultCodexConfigPath", () => {
  it("honors CODEX_HOME and falls back to ~/.codex", () => {
    const original = process.env.CODEX_HOME;
    try {
      process.env.CODEX_HOME = "/tmp/codex-home";
      expect(defaultCodexConfigPath()).toBe("/tmp/codex-home/config.toml");
      delete process.env.CODEX_HOME;
      expect(defaultCodexConfigPath()).toBe(join(homedir(), ".codex", "config.toml"));
    } finally {
      if (original === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = original;
    }
  });
});
