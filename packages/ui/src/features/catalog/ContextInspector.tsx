import { useMemo, useState } from "react";

import type {
  ContextPart,
  ContextSection,
  ContextSnapshot,
  Transformation,
} from "../../lib/types.ts";
import { TransformationEditor } from "../transformations/TransformationEditor.tsx";
import { ContextDiff } from "./ContextDiff.tsx";

export function ContextInspector({
  snapshot,
  onCreateTransformation,
  disabledIdentifiers = new Set(),
  onToggleIdentifier,
}: {
  snapshot: ContextSnapshot;
  onCreateTransformation?: (transformation: Transformation) => void;
  disabledIdentifiers?: ReadonlySet<string>;
  onToggleIdentifier?: (identifier: string, disabled: boolean) => void;
}) {
  const [sort, setSort] = useState<"payload" | "size">("payload");
  const [view, setView] = useState<"original" | "effective">("effective");
  const [toolView, setToolView] = useState<"description" | "json">("description");
  const [search, setSearch] = useState("");
  const [selection, setSelection] = useState("");
  const ordered = useMemo(
    () =>
      sort === "size"
        ? [...snapshot.parts].sort((left, right) => right.characters - left.characters)
        : snapshot.parts,
    [snapshot.parts, sort],
  );
  const visible = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase();
    if (needle === "") return ordered;
    return ordered.filter((part) => searchableText(part).toLocaleLowerCase().includes(needle));
  }, [ordered, search]);
  const [selectedId, setSelectedId] = useState(snapshot.parts[0]?.id);
  const selected = snapshot.parts.find((part) => part.id === selectedId) ?? snapshot.parts[0];
  const totalCharacters = snapshot.parts.reduce((total, part) => total + part.characters, 0);
  const hasTransformations = snapshot.parts.some((part) => part.originalText !== undefined);

  if (selected === undefined) {
    return (
      <EmptyState title="No context parts" detail="The selected Probe has no text or tools." />
    );
  }

  return (
    <div className="grid min-h-[calc(100vh-8.75rem)] grid-cols-1 xl:grid-cols-[19rem_minmax(28rem,1fr)_22rem]">
      <aside className="border-r border-line bg-panel">
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <div>
            <p className="section-label">Input composition</p>
            <p className="mt-1 text-xs text-muted">{formatNumber(totalCharacters)} characters</p>
          </div>
          <div className="flex rounded-md bg-canvas p-0.5 text-[10px]">
            <button
              type="button"
              className={sortButton(sort === "payload")}
              onClick={() => setSort("payload")}
            >
              Payload order
            </button>
            <button
              type="button"
              className={sortButton(sort === "size")}
              onClick={() => setSort("size")}
            >
              Largest first
            </button>
          </div>
        </div>
        <div className="border-b border-line p-2">
          <input
            type="search"
            aria-label="Search markdown"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            className="input"
            placeholder="Search all Markdown…"
          />
          {search.trim() === "" ? null : (
            <p className="mt-1 px-1 text-[10px] text-muted">{visible.length} matching parts</p>
          )}
        </div>
        <div className="max-h-[calc(100vh-13rem)] overflow-y-auto p-2">
          {visible.map((part) => (
            <PartButton
              key={part.id}
              part={part}
              totalCharacters={totalCharacters}
              selected={part.id === selected.id}
              onClick={() => setSelectedId(part.id)}
              disabledIdentifiers={disabledIdentifiers}
              onToggleIdentifier={onToggleIdentifier}
            />
          ))}
        </div>
      </aside>

      <section className="min-w-0 bg-canvas">
        <div className="flex items-start justify-between border-b border-line px-6 py-4">
          <div className="min-w-0">
            <div className="mb-2 flex items-center gap-2 text-[10px] uppercase tracking-[0.16em] text-muted">
              <span className={phaseBadge(selected.phase)}>{selected.phase}</span>
              <span>{selected.kind}</span>
              {selected.role === undefined ? null : <span>role: {selected.role}</span>}
            </div>
            <h1 className="truncate text-lg font-semibold tracking-tight">{selected.name}</h1>
            <p className="mt-1 truncate font-mono text-[11px] text-muted">{selected.path}</p>
          </div>
          <div className="ml-5 flex items-center gap-5">
            {hasTransformations ? (
              <div className="flex rounded-lg border border-line bg-panel p-1 text-[10px]">
                <button
                  type="button"
                  onClick={() => setView("original")}
                  className={viewButton(view === "original")}
                >
                  Original
                </button>
                <button
                  type="button"
                  onClick={() => setView("effective")}
                  className={viewButton(view === "effective")}
                >
                  Effective
                </button>
              </div>
            ) : null}
            <div className="grid grid-cols-2 gap-x-5 text-right">
              <Metric
                label="Characters"
                value={formatNumber(selectedText(selected, view).length)}
              />
              <Metric
                label="Est. tokens"
                value={`~${formatNumber(Math.ceil(selectedText(selected, view).length / 4))}`}
              />
            </div>
          </div>
        </div>
        {selected.description === undefined ? null : (
          <div className="flex gap-1 border-b border-line px-6 py-2 text-[11px]">
            <button
              type="button"
              className={viewButton(toolView === "description")}
              onClick={() => setToolView("description")}
            >
              Description
            </button>
            <button
              type="button"
              className={viewButton(toolView === "json")}
              onClick={() => setToolView("json")}
            >
              JSON
            </button>
          </div>
        )}
        <div className="h-[calc(100vh-15.5rem)] overflow-auto p-6">
          <ContextDiff
            key={`${selected.id}:${view}:${toolView}`}
            original={diffOriginal(selected, view, toolView)}
            effective={selectedContent(selected, view, toolView)}
            filename={
              selected.kind === "tool" && toolView === "json" ? "context.json" : "context.md"
            }
            search={search}
            onTransformSelection={setSelection}
          />
        </div>
        <div className="flex items-center justify-between border-t border-line px-6 py-2 font-mono text-[10px] text-muted">
          <span>sha256 {selected.digest.slice(0, 16)}…</span>
          <span>{selected.identifier === undefined ? "Opaque content" : selected.identifier}</span>
        </div>
      </section>

      <aside className="border-l border-line bg-panel p-4">
        <p className="section-label">Transform this part</p>
        <p className="mt-2 text-xs leading-5 text-muted">
          Mechanical matching only. The original capture remains immutable.
        </p>
        <TransformationEditor
          key={`${selected.id}:${selection}`}
          selectedPart={selected}
          initialFind={selection}
          onCreate={onCreateTransformation ?? (() => {})}
        />
      </aside>
    </div>
  );
}

function PartButton({
  part,
  totalCharacters,
  selected,
  onClick,
  disabledIdentifiers,
  onToggleIdentifier,
}: {
  part: ContextPart;
  totalCharacters: number;
  selected: boolean;
  onClick: () => void;
  disabledIdentifiers: ReadonlySet<string>;
  onToggleIdentifier?: (identifier: string, disabled: boolean) => void;
}) {
  const percent = totalCharacters === 0 ? 0 : (part.characters / totalCharacters) * 100;
  return (
    <div
      className={`mb-1 rounded-lg border transition ${
        selected
          ? "border-accent/50 bg-accent-dim"
          : "border-transparent hover:border-line hover:bg-panel-raised"
      }`}
    >
      <div className="flex items-start gap-1 px-2 py-2">
        <button type="button" onClick={onClick} className="min-w-0 flex-1 px-1 text-left">
          <div className="flex items-center justify-between gap-3">
            <span className="truncate text-xs font-medium">{part.name}</span>
            <span className="shrink-0 font-mono text-[10px] text-muted">
              {formatCompact(part.characters)} ch
            </span>
          </div>
          <div className="mt-2 h-1 overflow-hidden rounded-full bg-line">
            <div
              className="h-full rounded-full bg-accent"
              style={{ width: `${Math.max(percent, 1)}%` }}
            />
          </div>
          <div className="mt-1.5 flex items-center justify-between text-[10px] text-muted">
            <span>{part.phase}</span>
            <span>~{formatCompact(part.estimatedTokens)} tok</span>
          </div>
        </button>
        {part.identifier === undefined ? null : (
          <IdentifierToggle
            identifier={part.identifier}
            label={part.name}
            disabled={disabledIdentifiers.has(part.identifier)}
            onToggle={onToggleIdentifier}
          />
        )}
      </div>
      {!selected || part.sections === undefined ? null : (
        <div className="border-t border-line/70 px-2 py-1.5">
          <SectionTree
            sections={part.sections}
            disabledIdentifiers={disabledIdentifiers}
            onToggleIdentifier={onToggleIdentifier}
          />
        </div>
      )}
    </div>
  );
}

function SectionTree({
  sections,
  disabledIdentifiers,
  onToggleIdentifier,
}: {
  sections: ContextSection[];
  disabledIdentifiers: ReadonlySet<string>;
  onToggleIdentifier?: (identifier: string, disabled: boolean) => void;
}) {
  return (
    <div className="space-y-0.5">
      {sections.map((section) => (
        <details key={section.identifier} className="group">
          <summary className="flex cursor-pointer list-none items-center gap-1 py-1 text-[10px] text-muted">
            {section.children.length === 0 ? (
              <span className="w-3" />
            ) : (
              <span
                aria-label={`Expand ${section.label}`}
                role="button"
                className="w-3 text-center group-open:rotate-90"
              >
                ›
              </span>
            )}
            <span className="min-w-0 flex-1 truncate">{section.label}</span>
            <IdentifierToggle
              identifier={section.identifier}
              label={section.label}
              disabled={disabledIdentifiers.has(section.identifier)}
              onToggle={onToggleIdentifier}
            />
          </summary>
          {section.children.length === 0 ? null : (
            <div className="ml-3 border-l border-line pl-2">
              <SectionTree
                sections={section.children}
                disabledIdentifiers={disabledIdentifiers}
                onToggleIdentifier={onToggleIdentifier}
              />
            </div>
          )}
        </details>
      ))}
    </div>
  );
}

function IdentifierToggle({
  identifier,
  label,
  disabled,
  onToggle,
}: {
  identifier: string;
  label: string;
  disabled: boolean;
  onToggle?: (identifier: string, disabled: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={!disabled}
      aria-label={`${disabled ? "Enable" : "Disable"} ${label}`}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onToggle?.(identifier, !disabled);
      }}
      className={`relative mt-0.5 h-4 w-7 shrink-0 rounded-full transition ${disabled ? "bg-line" : "bg-accent"}`}
    >
      <span
        className={`absolute top-0.5 size-3 rounded-full bg-white transition ${disabled ? "left-0.5" : "left-3.5"}`}
      />
    </button>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[9px] uppercase tracking-[0.15em] text-muted">{label}</p>
      <p className="mt-1 font-mono text-xs text-ink">{value}</p>
    </div>
  );
}

export function EmptyState({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="grid min-h-[28rem] place-items-center p-8 text-center">
      <div>
        <p className="text-sm font-semibold">{title}</p>
        <p className="mt-2 max-w-sm text-xs leading-5 text-muted">{detail}</p>
      </div>
    </div>
  );
}

function sortButton(active: boolean): string {
  return `rounded px-2 py-1 transition ${active ? "bg-panel-raised text-ink" : "text-muted hover:text-ink"}`;
}

function viewButton(active: boolean): string {
  return `rounded-md px-2.5 py-1.5 transition ${active ? "bg-panel-raised text-ink" : "text-muted hover:text-ink"}`;
}

function selectedText(part: ContextPart, view: "original" | "effective"): string {
  return view === "original" ? (part.originalText ?? part.text) : part.text;
}

function selectedContent(
  part: ContextPart,
  view: "original" | "effective",
  toolView: "description" | "json",
): string {
  if (part.description === undefined) return selectedText(part, view);
  return toolView === "description" ? part.description : (part.json ?? part.text);
}

function diffOriginal(
  part: ContextPart,
  view: "original" | "effective",
  toolView: "description" | "json",
): string | undefined {
  if (view === "original" || toolView === "json") return undefined;
  return part.originalText;
}

function searchableText(part: ContextPart): string {
  return part.kind === "message" ? part.text : (part.description ?? "");
}

function phaseBadge(phase: ContextPart["phase"]): string {
  return phase === "prewarm"
    ? "rounded bg-violet-dim px-1.5 py-0.5 text-violet"
    : "rounded bg-accent-dim px-1.5 py-0.5 text-accent";
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

function formatCompact(value: number): string {
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(
    value,
  );
}
