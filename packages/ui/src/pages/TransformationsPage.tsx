import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { EmptyState } from "../features/catalog/ContextInspector.tsx";
import { TransformationEditor } from "../features/transformations/TransformationEditor.tsx";
import { getTransformations, putTransformations } from "../lib/api.ts";
import type { Transformation, TransformationSet } from "../lib/types.ts";

export function TransformationsPage() {
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ["transformations"], queryFn: getTransformations });
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
    replace({ version: 1, transformations: [...set.transformations, rule] });

  return (
    <div className="grid min-h-[calc(100vh-3.5rem)] grid-cols-1 lg:grid-cols-[1fr_24rem]">
      <section className="border-r border-line p-6 lg:p-8">
        <div className="mb-6 flex items-end justify-between">
          <div>
            <p className="section-label">Ordered pipeline</p>
            <h1 className="mt-2 text-2xl font-semibold tracking-tight">Transformations</h1>
            <p className="mt-2 max-w-xl text-sm leading-6 text-muted">
              Exact mechanical rewrites. Rules run top to bottom; captures remain immutable.
            </p>
          </div>
          <span className="rounded-full border border-line px-3 py-1 text-xs text-muted">
            {set.transformations.length} rules
          </span>
        </div>
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
      <aside className="bg-panel p-5">
        <p className="section-label">New transformation</p>
        <p className="mt-2 text-xs leading-5 text-muted">
          Global by default. Open scope controls for harness, model, or project overrides.
        </p>
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
}: {
  rule: Transformation;
  index: number;
  onToggle: () => void;
  onDelete: () => void;
}) {
  return (
    <article
      className={`rounded-xl border p-4 ${rule.enabled ? "border-line bg-panel" : "border-line/60 bg-panel/40 opacity-60"}`}
    >
      <div className="flex items-start gap-4">
        <span className="grid size-7 shrink-0 place-items-center rounded-md bg-canvas font-mono text-[10px] text-muted">
          {index + 1}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-4">
            <h2 className="truncate text-sm font-semibold">{rule.name}</h2>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onToggle}
                className={`rounded-full px-2.5 py-1 text-[10px] font-semibold ${rule.enabled ? "bg-accent-dim text-accent" : "bg-canvas text-muted"}`}
              >
                {rule.enabled ? "Enabled" : "Disabled"}
              </button>
              <button
                type="button"
                onClick={onDelete}
                className="rounded px-2 py-1 text-[10px] text-muted hover:bg-danger-dim hover:text-danger"
              >
                Delete
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
          </div>
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

function Tag({ children }: { children: React.ReactNode }) {
  return <span className="rounded bg-canvas px-2 py-1 font-mono">{children}</span>;
}

function CodePreview({ children }: { children: React.ReactNode }) {
  return (
    <pre className="mt-3 truncate rounded-md bg-canvas px-3 py-2 font-mono text-[10px] text-content">
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
