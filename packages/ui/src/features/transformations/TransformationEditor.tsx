import { useState, type FormEvent } from "react";

import type { ContextPart, HarnessKind, JsonPathSegment, Transformation } from "../../lib/types.ts";

export function TransformationEditor({
  onCreate,
  selectedPart,
  initialFind = "",
  initialJsonPath,
}: {
  onCreate: (transformation: Transformation) => void;
  selectedPart?: ContextPart;
  initialFind?: string;
  initialJsonPath?: JsonPathSegment[];
}) {
  const [name, setName] = useState("");
  const [field, setField] = useState<Transformation["target"]["field"]>(
    initialJsonPath !== undefined
      ? "json_value"
      : selectedPart?.kind === "tool"
        ? "tool_description"
        : "message_text",
  );
  const [operation, setOperation] = useState<"replace" | "replace_all" | "regex" | "delete_part">(
    "replace_all",
  );
  const [find, setFind] = useState(initialFind);
  const [replacement, setReplacement] = useState("");
  const [jsonPath, setJsonPath] = useState(JSON.stringify(initialJsonPath ?? []));
  const [jsonPathError, setJsonPathError] = useState("");
  const [flags, setFlags] = useState("");
  const [harness, setHarness] = useState<"all" | HarnessKind>("all");
  const [model, setModel] = useState("");
  const [project, setProject] = useState("");
  const [segment, setSegment] = useState(
    selectedPart?.identifier?.startsWith("segment:") === true ? selectedPart.identifier : "all",
  );
  const [toolDefinition, setToolDefinition] = useState(
    selectedPart?.kind === "tool" && selectedPart.identifier?.startsWith("tool:") === true
      ? selectedPart.identifier
      : "",
  );

  function submit(event: FormEvent) {
    event.preventDefault();
    let parsedJsonPath: JsonPathSegment[] | undefined;
    if (field === "json_value") {
      try {
        parsedJsonPath = parseJsonPath(jsonPath);
        setJsonPathError("");
      } catch (error) {
        setJsonPathError(error instanceof Error ? error.message : String(error));
        return;
      }
    }
    onCreate({
      id: `rule-${Date.now()}`,
      name: name.trim(),
      enabled: true,
      scope: {
        ...(harness === "all" ? {} : { harnesses: [harness] }),
        ...(model.trim() === "" ? {} : { models: [model.trim()] }),
        ...(project.trim() === "" ? {} : { projects: [project.trim()] }),
        ...(segment === "all" ? {} : { segments: [segment] }),
        ...(toolDefinition.trim() === "" ? {} : { tools: [toolDefinition.trim()] }),
      },
      target: {
        field,
        ...(parsedJsonPath === undefined ? {} : { jsonPath: parsedJsonPath }),
        ...(selectedPart?.identifier === undefined
          ? selectedPart === undefined
            ? {}
            : { path: selectedPart.path }
          : operation === "delete_part" && field !== "json_value"
            ? { identifier: selectedPart.identifier }
            : {}),
      },
      operation: operationValue(operation, find, replacement, flags),
    });
    setName("");
    setFind("");
    setReplacement("");
  }

  return (
    <form className="mt-4 space-y-3" onSubmit={submit}>
      <Field label="Name">
        <input
          required
          value={name}
          onChange={(event) => setName(event.target.value)}
          className="input"
          placeholder="Shorten project rules"
        />
      </Field>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Target field">
          <select
            value={field}
            onChange={(event) => setField(event.target.value as typeof field)}
            className="input"
          >
            <option value="message_text">Message text</option>
            <option value="tool_description">Tool description</option>
            <option value="json_value">JSON value</option>
            <option value="all_text">All text leaves</option>
            <option value="tool">Whole tool</option>
          </select>
        </Field>
        <Field label="Operation">
          <select
            value={operation}
            onChange={(event) => setOperation(event.target.value as typeof operation)}
            className="input"
          >
            <option value="replace_all">Replace all</option>
            <option value="replace">Replace first</option>
            <option value="regex">RE2 regexp</option>
            <option value="delete_part">Delete part</option>
          </select>
        </Field>
      </div>
      {field === "json_value" ? (
        <Field label="JSON path">
          <div>
            <input
              required
              aria-invalid={jsonPathError === "" ? undefined : true}
              value={jsonPath}
              onChange={(event) => {
                setJsonPath(event.target.value);
                setJsonPathError("");
              }}
              className="input font-mono"
              placeholder={'["parameters","properties","cmd","description"]'}
            />
            {jsonPathError === "" ? null : (
              <p className="mt-1 text-[10px] normal-case tracking-normal text-red-400">
                {jsonPathError}
              </p>
            )}
          </div>
        </Field>
      ) : null}
      {operation === "delete_part" ? null : (
        <>
          <Field label={operation === "regex" ? "Pattern" : "Find"}>
            <textarea
              required
              value={find}
              onChange={(event) => setFind(event.target.value)}
              className="input min-h-20 resize-y font-mono"
              placeholder={operation === "regex" ? "exact (text|content)" : "Exact text"}
            />
          </Field>
          <Field label="Replace with">
            <textarea
              value={replacement}
              onChange={(event) => setReplacement(event.target.value)}
              className="input min-h-16 resize-y font-mono"
              placeholder="Empty removes matches"
            />
          </Field>
        </>
      )}
      {operation === "regex" ? (
        <Field label="Flags">
          <input
            value={flags}
            onChange={(event) => setFlags(event.target.value)}
            className="input font-mono"
            placeholder="ims"
          />
        </Field>
      ) : null}
      <div className="space-y-3 pt-1">
        <p className="text-[10px] font-semibold uppercase tracking-[0.15em] text-muted">Scope</p>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Harness">
            <select
              value={harness}
              onChange={(event) => setHarness(event.target.value as typeof harness)}
              className="input"
            >
              <option value="all">Any harness</option>
              <option value="tui">Codex TUI</option>
              <option value="desktop">Codex Desktop</option>
            </select>
          </Field>
          <Field label="Codex segment">
            <select
              value={segment}
              onChange={(event) => setSegment(event.target.value)}
              className="input"
            >
              <option value="all">Any segment</option>
              {CODEX_SEGMENTS.map(([identifier, label]) => (
                <option key={identifier} value={identifier}>
                  {label}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <div className="space-y-3">
          <Field label="Tool definition">
            <input
              value={toolDefinition}
              onChange={(event) => setToolDefinition(event.target.value)}
              className="input font-mono"
              placeholder="Any tool definition"
            />
          </Field>
          <Field label="Model">
            <input
              value={model}
              onChange={(event) => setModel(event.target.value)}
              className="input"
              placeholder="Any model"
            />
          </Field>
          <Field label="Project">
            <input
              value={project}
              onChange={(event) => setProject(event.target.value)}
              className="input"
              placeholder="Any project"
            />
          </Field>
        </div>
      </div>
      <button
        type="submit"
        className="w-full rounded-lg bg-accent px-3 py-2 text-xs font-semibold text-canvas transition hover:bg-accent-bright focus:outline-none focus:ring-2 focus:ring-accent/40"
      >
        Add transformation
      </button>
    </form>
  );
}

const CODEX_SEGMENTS = [
  ["segment:codex_base", "Codex base instructions"],
  ["segment:skills", "Skills instructions"],
  ["segment:permissions", "Permissions"],
  ["segment:apps", "Apps instructions"],
  ["segment:plugins", "Plugins instructions"],
  ["segment:recommended_plugins", "Recommended plugins"],
  ["segment:project_instructions", "Project instructions"],
  ["segment:environment", "Environment context"],
] as const;

function Field({ label, children }: { label: string; children: React.ReactElement }) {
  return (
    <label className="block text-[10px] font-medium uppercase tracking-[0.12em] text-muted">
      <span className="mb-1.5 block">{label}</span>
      {children}
    </label>
  );
}

function operationValue(
  operation: "replace" | "replace_all" | "regex" | "delete_part",
  find: string,
  replacement: string,
  flags: string,
): Transformation["operation"] {
  if (operation === "delete_part") return { type: operation };
  if (operation === "regex") {
    return { type: operation, pattern: find, replacement, flags, replaceAll: true };
  }
  return { type: operation, find, replacement };
}

function parseJsonPath(value: string): JsonPathSegment[] {
  const parsed: unknown = JSON.parse(value);
  if (
    !Array.isArray(parsed) ||
    parsed.length === 0 ||
    !parsed.every(
      (segment) =>
        typeof segment === "string" ||
        (typeof segment === "number" && Number.isSafeInteger(segment) && segment >= 0),
    )
  ) {
    throw new Error("Use a non-empty JSON array of strings and non-negative integers.");
  }
  return parsed as JsonPathSegment[];
}
