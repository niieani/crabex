import { useMemo, useState } from "react";

import type { ContextPart, ContextSnapshot, Transformation } from "../../lib/types.ts";
import { TransformationEditor } from "../transformations/TransformationEditor.tsx";

export function ContextInspector({
  snapshot,
  onCreateTransformation,
}: {
  snapshot: ContextSnapshot;
  onCreateTransformation?: (transformation: Transformation) => void;
}) {
  const [sort, setSort] = useState<"payload" | "size">("payload");
  const ordered = useMemo(
    () =>
      sort === "size"
        ? [...snapshot.parts].sort((left, right) => right.characters - left.characters)
        : snapshot.parts,
    [snapshot.parts, sort],
  );
  const [selectedId, setSelectedId] = useState(snapshot.parts[0]?.id);
  const selected = snapshot.parts.find((part) => part.id === selectedId) ?? snapshot.parts[0];
  const totalCharacters = snapshot.parts.reduce((total, part) => total + part.characters, 0);

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
        <div className="max-h-[calc(100vh-13rem)] overflow-y-auto p-2">
          {ordered.map((part) => (
            <PartButton
              key={part.id}
              part={part}
              totalCharacters={totalCharacters}
              selected={part.id === selected.id}
              onClick={() => setSelectedId(part.id)}
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
          <div className="ml-5 grid grid-cols-2 gap-x-5 text-right">
            <Metric label="Characters" value={formatNumber(selected.characters)} />
            <Metric label="Est. tokens" value={`~${formatNumber(selected.estimatedTokens)}`} />
          </div>
        </div>
        <div className="h-[calc(100vh-15.5rem)] overflow-auto p-6">
          <pre className="whitespace-pre-wrap break-words font-mono text-[12px] leading-5 text-content">
            {selected.text}
          </pre>
        </div>
        <div className="flex items-center justify-between border-t border-line px-6 py-2 font-mono text-[10px] text-muted">
          <span>sha256 {selected.digest.slice(0, 16)}…</span>
          <span>Opaque content · no semantic parsing</span>
        </div>
      </section>

      <aside className="border-l border-line bg-panel p-4">
        <p className="section-label">Transform this part</p>
        <p className="mt-2 text-xs leading-5 text-muted">
          Mechanical matching only. The original capture remains immutable.
        </p>
        <TransformationEditor
          key={selected.id}
          selectedPart={selected}
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
}: {
  part: ContextPart;
  totalCharacters: number;
  selected: boolean;
  onClick: () => void;
}) {
  const percent = totalCharacters === 0 ? 0 : (part.characters / totalCharacters) * 100;
  return (
    <button
      type="button"
      onClick={onClick}
      className={`mb-1 w-full rounded-lg border px-3 py-2.5 text-left transition ${
        selected
          ? "border-accent/50 bg-accent-dim"
          : "border-transparent hover:border-line hover:bg-panel-raised"
      }`}
    >
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
