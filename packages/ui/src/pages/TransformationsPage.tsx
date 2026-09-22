import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Trash2 } from "lucide-react";

import { EmptyState } from "../features/catalog/ContextInspector.tsx";
import { TransformationEditor } from "../features/transformations/TransformationEditor.tsx";
import { getTransformations, getTransformationTelemetry, putTransformations } from "../lib/api.ts";
import type { Transformation, TransformationSet, TransformationTelemetry } from "../lib/types.ts";

export function TransformationsPage() {
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ["transformations"], queryFn: getTransformations });
  const telemetryQuery = useQuery({
    queryKey: ["transformation-telemetry"],
    queryFn: getTransformationTelemetry,
  });
  const mutation = useMutation({
    mutationFn: putTransformations,
    onSuccess: (set) => queryClient.setQueryData(["transformations"], set),
  });
  const set = query.data;

  if (query.isPending)
    return <EmptyState title="Loading transformations" detail="Reading the local rule set…" />;
  if (query.isError)
    return <EmptyState title="Proxy API unavailable" detail={query.error.message} />;
  if (set === undefined) return null;

  const replace = (next: TransformationSet) => mutation.mutate(next);
  const add = (rule: Transformation) =>
    mutation.mutateAsync({ version: 1, transformations: [...set.transformations, rule] });

  return (
    <div className="management-layout">
      <section className="border-r border-line p-6 lg:min-h-0 lg:overflow-y-auto lg:p-8">
        <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="section-label">Ordered pipeline</p>
            <h1 className="mt-2 text-2xl font-semibold tracking-tight">Transformations</h1>
          </div>
          <span className="rounded-full border border-line px-3 py-1 text-xs text-muted">
            {set.transformations.length} rules
          </span>
        </div>
        {mutation.isError ? (
          <p role="alert" className="mb-4 rounded-md bg-danger-dim p-3 text-xs text-danger">
            {mutation.error.message}
          </p>
        ) : null}
        <div className="space-y-2">
          {set.transformations.length === 0 ? (
            <div className="rounded-xl border border-dashed border-line p-10 text-center text-sm text-muted">
              No transformations yet.
            </div>
          ) : (
            set.transformations.map((rule, index) => (
              <RuleCard
                key={rule.id}
                rule={rule}
                index={index}
                pending={mutation.isPending}
                last={index === set.transformations.length - 1}
                onMove={(offset) => {
                  const reordered = [...set.transformations];
                  [reordered[index], reordered[index + offset]] = [
                    reordered[index + offset]!,
                    reordered[index]!,
                  ];
                  replace({ ...set, transformations: reordered });
                }}
                telemetry={telemetryQuery.data?.find((item) => item.transformationId === rule.id)}
                onToggle={() =>
                  replace(updateRule(set, rule.id, { ...rule, enabled: !rule.enabled }))
                }
                onDelete={() =>
                  replace({
                    version: 1,
                    transformations: set.transformations.filter((item) => item.id !== rule.id),
                  })
                }
              />
            ))
          )}
        </div>
      </section>
      <aside className="bg-panel p-5 lg:min-h-0 lg:overflow-y-auto">
        <p className="section-label">New transformation</p>
        <TransformationEditor onCreate={add} />
      </aside>
    </div>
  );
}

function RuleCard({
  rule,
  index,
  onToggle,
  onDelete,
  telemetry,
  onMove,
  pending,
  last,
}: {
  rule: Transformation;
  index: number;
  onToggle: () => void;
  onDelete: () => void;
  telemetry?: TransformationTelemetry;
  onMove: (offset: number) => void;
  pending: boolean;
  last: boolean;
}) {
  return (
    <article
      className={`rounded-lg border p-4 ${rule.enabled ? "border-line bg-panel" : "border-line/60 bg-panel/40 opacity-60"}`}
    >
      <div className="flex items-start gap-4">
        <span className="grid size-7 shrink-0 place-items-center rounded-md bg-canvas font-mono text-[10px] text-muted">
          {index + 1}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="truncate text-sm font-semibold">{rule.name}</h2>
            <div className="flex items-center gap-2">
              <button
                type="button"
                role="switch"
                aria-label={`Enable ${rule.name}`}
                aria-checked={rule.enabled}
                disabled={pending}
                onClick={onToggle}
                className={`toggle-switch ${rule.enabled ? "on" : ""}`}
              >
                <span />
              </button>
              <button
                className="icon-button"
                title="Move rule up"
                aria-label={`Move ${rule.name} up`}
                disabled={pending || index === 0}
                onClick={() => onMove(-1)}
              >
                <ArrowUp size={14} />
              </button>
              <button
                className="icon-button"
                title="Move rule down"
                aria-label={`Move ${rule.name} down`}
                disabled={pending || last}
                onClick={() => onMove(1)}
              >
                <ArrowDown size={14} />
              </button>
              <button
                type="button"
                title="Delete rule"
                aria-label={`Delete ${rule.name}`}
                disabled={pending}
                onClick={onDelete}
                className="icon-button hover:text-danger"
              >
                <Trash2 size={14} />
              </button>
            </div>
          </div>
          <div className="mt-3 flex flex-wrap gap-1.5 text-[10px] text-muted">
            <Tag>{rule.target.field}</Tag>
            <Tag>{rule.operation.type}</Tag>
            {rule.scope.harnesses?.map((value) => (
              <Tag key={value}>{value}</Tag>
            ))}
            {rule.scope.models?.map((value) => (
              <Tag key={value}>{value}</Tag>
            ))}
            {rule.scope.projects?.map((value) => (
              <Tag key={value}>project:{value}</Tag>
            ))}
            {rule.scope.segments?.map((value) => (
              <Tag key={value}>{value}</Tag>
            ))}
            {rule.scope.tools?.map((value) => (
              <Tag key={value}>{value}</Tag>
            ))}
            {rule.target.jsonPath === undefined ? null : (
              <Tag>path:{JSON.stringify(rule.target.jsonPath)}</Tag>
            )}
          </div>
          <RuleTelemetry telemetry={telemetry} />
          {"find" in rule.operation ? <CodePreview>{rule.operation.find}</CodePreview> : null}
          {"pattern" in rule.operation ? (
            <CodePreview>
              /{rule.operation.pattern}/{rule.operation.flags}
            </CodePreview>
          ) : null}
        </div>
      </div>
    </article>
  );
}

function RuleTelemetry({ telemetry }: { telemetry?: TransformationTelemetry }) {
  if (telemetry === undefined) {
    return <p className="mt-3 text-[10px] text-muted">Not evaluated in recorded probes</p>;
  }
  const total = telemetry.hits + telemetry.misses + telemetry.errors;
  const hitWidth = `${(telemetry.hits / total) * 100}%`;
  const missWidth = `${(telemetry.misses / total) * 100}%`;
  const errorWidth = `${(telemetry.errors / total) * 100}%`;
  return (
    <div className="mt-3" title={`Last evaluated ${telemetry.lastRunAt}`}>
      <div className="flex h-1.5 overflow-hidden rounded-full bg-canvas">
        <span className="bg-accent" style={{ width: hitWidth }} />
        <span className="bg-muted" style={{ width: missWidth }} />
        <span className="bg-danger" style={{ width: errorWidth }} />
      </div>
      <p className="mt-1.5 text-[10px] text-muted">
        {telemetry.hits} hit · {telemetry.misses} miss · {telemetry.errors} error ·{" "}
        {telemetry.matchCount} matches
      </p>
    </div>
  );
}

function Tag({ children }: { children: React.ReactNode }) {
  return <span className="rounded bg-canvas px-2 py-1 font-mono">{children}</span>;
}

function CodePreview({ children }: { children: React.ReactNode }) {
  return (
    <pre className="mt-3 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md bg-canvas px-3 py-2 font-mono text-[10px] text-content">
      {children}
    </pre>
  );
}

function updateRule(
  set: TransformationSet,
  id: string,
  replacement: Transformation,
): TransformationSet {
  return {
    version: 1,
    transformations: set.transformations.map((rule) => (rule.id === id ? replacement : rule)),
  };
}
