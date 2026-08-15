import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { ContextInspector, EmptyState } from "../features/catalog/ContextInspector.tsx";
import { getSnapshots, getTransformations, putTransformations } from "../lib/api.ts";
import type { Transformation } from "../lib/types.ts";

export function CatalogPage() {
  const queryClient = useQueryClient();
  const snapshotsQuery = useQuery({
    queryKey: ["snapshots"],
    queryFn: getSnapshots,
    refetchInterval: 3000,
  });
  const transformationsQuery = useQuery({
    queryKey: ["transformations"],
    queryFn: getTransformations,
  });
  const snapshots = snapshotsQuery.data ?? [];
  const [selectedId, setSelectedId] = useState<string>();
  useEffect(() => {
    if (selectedId === undefined && snapshots[0] !== undefined) setSelectedId(snapshots[0].id);
  }, [selectedId, snapshots]);
  const snapshot = snapshots.find((value) => value.id === selectedId) ?? snapshots[0];
  const mutation = useMutation({
    mutationFn: putTransformations,
    onSuccess: (set) => queryClient.setQueryData(["transformations"], set),
  });

  function createTransformation(transformation: Transformation) {
    const current = transformationsQuery.data;
    if (current === undefined) return;
    mutation.mutate({ version: 1, transformations: [...current.transformations, transformation] });
  }

  return (
    <div>
      <div className="flex min-h-20 flex-wrap items-center justify-between gap-4 border-b border-line bg-panel px-5 py-3">
        <div className="flex items-center gap-5">
          <div>
            <p className="section-label">Observed snapshot</p>
            <select
              aria-label="Snapshot"
              value={snapshot?.id ?? ""}
              onChange={(event) => setSelectedId(event.target.value)}
              className="mt-1 max-w-80 bg-transparent text-sm font-medium outline-none"
            >
              {snapshots.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.model} · {item.harness.kind} · {new Date(item.timestamp).toLocaleString()}
                </option>
              ))}
            </select>
          </div>
          {snapshot === undefined ? null : (
            <>
              <HeaderMetric
                label="Harness"
                value={harnessLabel(snapshot.harness.kind, snapshot.harness.version)}
              />
              <HeaderMetric label="Project" value={snapshot.project ?? "unscoped"} />
              <HeaderMetric
                label="Input"
                value={
                  snapshot.usage === undefined
                    ? "pending"
                    : `${format(snapshot.usage.inputTokens)} tokens`
                }
              />
              <HeaderMetric
                label="Cached"
                value={
                  snapshot.usage === undefined
                    ? "—"
                    : `${format(snapshot.usage.cachedTokens)} tokens`
                }
              />
            </>
          )}
        </div>
        <div className="flex items-center gap-3 text-xs">
          <span className="rounded-full border border-line px-2.5 py-1 text-muted">
            {snapshots.length} observed
          </span>
          <span className="flex items-center gap-1.5 text-accent">
            <span className="size-1.5 rounded-full bg-accent" /> Live refresh
          </span>
        </div>
      </div>
      {snapshotsQuery.isPending ? (
        <EmptyState
          title="Reading captures"
          detail="Reconstructing linked prewarm and inference requests…"
        />
      ) : snapshotsQuery.isError ? (
        <EmptyState title="Proxy API unavailable" detail={snapshotsQuery.error.message} />
      ) : snapshot === undefined ? (
        <EmptyState
          title="No Probes captured"
          detail="Run a trivial Codex prompt through the proxy, then return here."
        />
      ) : (
        <ContextInspector snapshot={snapshot} onCreateTransformation={createTransformation} />
      )}
      {mutation.isError ? <Toast tone="error">{mutation.error.message}</Toast> : null}
      {mutation.isSuccess ? <Toast tone="success">Transformation saved</Toast> : null}
    </div>
  );
}

function HeaderMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="hidden border-l border-line pl-5 lg:block">
      <p className="text-[9px] uppercase tracking-[0.16em] text-muted">{label}</p>
      <p className="mt-1 text-xs font-medium">{value}</p>
    </div>
  );
}

function Toast({ tone, children }: { tone: "error" | "success"; children: React.ReactNode }) {
  return (
    <div
      className={`fixed bottom-4 right-4 rounded-lg border px-4 py-2 text-xs shadow-xl ${tone === "error" ? "border-danger/40 bg-danger-dim text-danger" : "border-accent/40 bg-accent-dim text-accent"}`}
    >
      {children}
    </div>
  );
}

function harnessLabel(kind: string, version?: string): string {
  return `${kind}${version === undefined ? "" : ` ${version}`}`;
}

function format(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}
