import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { LEGACY_NAME } from "./legacy-migration.ts";

const MANAGED_MARKER = "crabex";

export interface CodexConfigToggleDefinition {
  key: string;
  label: string;
  description: string;
  managedValue: string;
}

export interface CodexConfigToggleState extends CodexConfigToggleDefinition {
  enabled: boolean;
  effectiveValue?: string;
  preservedValue?: string;
}

export interface CodexConfigState {
  path: string;
  exists: boolean;
  parseError?: string;
  toggles: CodexConfigToggleState[];
}

export interface CodexConfigManager {
  state(): Promise<CodexConfigState>;
  setEnabled(key: string, enabled: boolean): Promise<CodexConfigState>;
}

export function defaultCodexConfigPath(): string {
  const codexHome = process.env.CODEX_HOME ?? join(homedir(), ".codex");
  return join(codexHome, "config.toml");
}

export function codexConfigToggles(proxyOrigin: string): CodexConfigToggleDefinition[] {
  return [
    {
      key: "openai_base_url",
      label: "Responses & models",
      description:
        "Route the Responses API (HTTP and WebSocket) and the model list through the proxy.",
      managedValue: `${proxyOrigin}/backend-api/codex`,
    },
    {
      key: "chatgpt_base_url",
      label: "ChatGPT services",
      description:
        "Route the config bundle and Apps through the proxy. Keep the Apps authentication relay below enabled for native Apps access.",
      managedValue: `${proxyOrigin}/backend-api`,
    },
  ];
}

export function createCodexConfigManager(options: {
  configPath: string;
  proxyOrigin: string;
}): CodexConfigManager {
  const definitions = codexConfigToggles(options.proxyOrigin);

  async function readText(): Promise<string | undefined> {
    try {
      return await readFile(options.configPath, "utf8");
    } catch (error) {
      if (isMissingFile(error)) return undefined;
      throw error;
    }
  }

  async function state(): Promise<CodexConfigState> {
    const text = await readText();
    const content = text ?? "";
    let parsed: Record<string, unknown> | undefined;
    let parseError: string | undefined;
    if (content.trim() !== "") {
      try {
        parsed = objectValue(Bun.TOML.parse(content));
      } catch (error) {
        parseError = errorMessage(error);
      }
    }
    let toggles: CodexConfigToggleState[];
    try {
      toggles = definitions.map((definition) => toggleState(content, definition, parsed));
    } catch (error) {
      parseError = errorMessage(error);
      toggles = definitions.map((definition) => ({ ...definition, enabled: false }));
    }
    return {
      path: options.configPath,
      exists: text !== undefined,
      ...(parseError === undefined ? {} : { parseError }),
      toggles,
    };
  }

  return {
    state,
    async setEnabled(key, enabled) {
      const definition = definitions.find((item) => item.key === key);
      if (definition === undefined) {
        throw new Error(`unsupported codex config toggle: ${key}`);
      }
      const text = (await readText()) ?? "";
      const next = applyCodexConfigToggle(text, key, definition.managedValue, enabled);
      await writeAtomic(options.configPath, next);
      return state();
    },
  };
}

export function applyCodexConfigToggle(
  text: string,
  key: string,
  managedValue: string,
  enabled: boolean,
): string {
  const stripped = stripFence(migrateCodexConfigText(text).split("\n"), key);
  if (!enabled) {
    const output = [...stripped.lines];
    if (stripped.preserved.length > 0) {
      output.splice(stripped.removedAt ?? output.length, 0, ...stripped.preserved);
    }
    return finalize(output);
  }
  const extracted = extractTopLevel(stripped.lines, key);
  const statements = extracted.statements.length > 0 ? extracted.statements : stripped.preserved;
  const block = [
    fenceOpen(key),
    ...statements.map((statement) => `# ${statement}`),
    `${key} = ${JSON.stringify(managedValue)}`,
    fenceClose(key),
  ];
  const output = [...extracted.lines];
  output.splice(extracted.firstIndex ?? stripped.removedAt ?? 0, 0, ...block);
  return finalize(output);
}

function toggleState(
  content: string,
  definition: CodexConfigToggleDefinition,
  parsed: Record<string, unknown> | undefined,
): CodexConfigToggleState {
  const stripped = stripFence(migrateCodexConfigText(content).split("\n"), definition.key);
  const effective = parsed?.[definition.key];
  const preserved = stripped.preserved[0];
  return {
    ...definition,
    enabled: stripped.removedAt !== undefined && effective === definition.managedValue,
    ...(typeof effective === "string" ? { effectiveValue: effective } : {}),
    ...(preserved === undefined ? {} : { preservedValue: preserved }),
  };
}

/** Renames fences written under the former project name. */
export function migrateCodexConfigText(text: string): string {
  return text.replace(
    new RegExp(`^(\\s*# (?:>>>|<<<) )${LEGACY_NAME}:`, "gm"),
    `$1${MANAGED_MARKER}:`,
  );
}

/** Rewrites legacy fences in place; returns a notice when the file changed. */
export async function migrateCodexConfigFile(path: string): Promise<string | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (isMissingFile(error)) return undefined;
    throw error;
  }
  const migrated = migrateCodexConfigText(text);
  if (migrated === text) return undefined;
  await writeAtomic(path, migrated);
  return `Renamed ${LEGACY_NAME} fences in ${path}`;
}

function stripFence(
  lines: string[],
  key: string,
): { lines: string[]; preserved: string[]; removedAt?: number } {
  const open = fenceOpen(key);
  const close = fenceClose(key);
  const output: string[] = [];
  const preserved: string[] = [];
  let removedAt: number | undefined;
  let inside = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!inside && trimmed === open) {
      inside = true;
      removedAt ??= output.length;
      continue;
    }
    if (inside) {
      if (trimmed === close) {
        inside = false;
        continue;
      }
      const commented = /^#\s*(.*)$/.exec(trimmed)?.[1];
      if (commented !== undefined && keyPattern(key).test(commented)) {
        preserved.push(commented);
      }
      continue;
    }
    output.push(line);
  }
  if (inside) {
    throw new Error(`unclosed ${MANAGED_MARKER} fence for ${key}`);
  }
  return { lines: output, preserved, ...(removedAt === undefined ? {} : { removedAt }) };
}

function extractTopLevel(
  lines: string[],
  key: string,
): { lines: string[]; statements: string[]; firstIndex?: number } {
  const pattern = keyPattern(key);
  const output: string[] = [];
  const statements: string[] = [];
  let firstIndex: number | undefined;
  let inTable = false;
  let inFence = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith(`# >>> ${MANAGED_MARKER}:`)) inFence = true;
    if (inFence) {
      output.push(line);
      if (trimmed.startsWith(`# <<< ${MANAGED_MARKER}:`)) inFence = false;
      continue;
    }
    if (trimmed.startsWith("[")) inTable = true;
    if (!inTable && !trimmed.startsWith("#") && pattern.test(trimmed)) {
      const value = trimmed.slice(trimmed.indexOf("=") + 1).trim();
      if (value.startsWith('"""') || value.startsWith("'''")) {
        throw new Error(
          `${key} uses a multiline string; remove it from config.toml manually before enabling`,
        );
      }
      firstIndex ??= output.length;
      statements.push(trimmed);
      continue;
    }
    output.push(line);
  }
  return { lines: output, statements, ...(firstIndex === undefined ? {} : { firstIndex }) };
}

function keyPattern(key: string): RegExp {
  return new RegExp(`^${key}\\s*=`);
}

function fenceOpen(key: string): string {
  return `# >>> ${MANAGED_MARKER}:${key} >>>`;
}

function fenceClose(key: string): string {
  return `# <<< ${MANAGED_MARKER}:${key} <<<`;
}

function finalize(lines: string[]): string {
  const text = lines.join("\n");
  return text.endsWith("\n") ? text : `${text}\n`;
}

async function writeAtomic(filePath: string, text: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  let mode = 0o600;
  try {
    mode = (await stat(filePath)).mode & 0o777;
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, text, { mode });
  await rename(temporaryPath, filePath);
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
