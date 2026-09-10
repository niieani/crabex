import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { ContextInspector, EmptyState } from "../features/catalog/ContextInspector.tsx";
import {
  getSnapshots,
  getTransformations,
  previewSnapshot,
  putTransformations,
} from "../lib/api.ts";
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
  const previewQuery = useQuery({
    queryKey: ["preview", snapshot?.id, transformationsQuery.data?.transformations],
    queryFn: () => previewSnapshot(snapshot!.id, transformationsQuery.data!.transformations),
    enabled: snapshot !== undefined && transformationsQuery.data !== undefined,
  });
  const displayedSnapshot = previewQuery.data ?? snapshot;
  const mutation = useMutation({
    mutationFn: putTransformations,
    onSuccess: (set) => queryClient.setQueryData(["transformations"], set),
  });

  function createTransformation(transformation: Transformation) {
    const current = transformationsQuery.data;
    if (current === undefined) return;
    mutation.mutate({ version: 1, transformations: [...current.transformations, transformation] });
  }

  const disabledIdentifiers = new Set(
    (transformationsQuery.data?.transformations ?? [])
      .filter(
        (rule) =>
          rule.enabled &&
          rule.operation.type === "delete_part" &&
          rule.target.identifier !== undefined,
      )
      .map((rule) => rule.target.identifier!),
  );

  function toggleIdentifier(identifier: string, disabled: boolean) {
    const current = transformationsQuery.data;
    if (current === undefined) return;
    const id = `disable:${identifier}`;
    const withoutToggle = current.transformations.filter((rule) => rule.id !== id);
    mutation.mutate({
      version: 1,
      transformations: disabled
        ? [
            ...withoutToggle,
            {
              id,
              name: `Disable ${identifier}`,
              enabled: true,
              scope: {},
              target: {
                field:
                  identifier.startsWith("tool:") ||
                  identifier.startsWith("registry:") ||
                  identifier.startsWith("registry-group:")
                    ? "tool"
                    : "message_text",
                identifier,
              },
              operation: { type: "delete_part" },
            },
          ]
        : withoutToggle,
    });
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto xl:overflow-hidden">
      <div className="flex min-h-20 shrink-0 flex-wrap items-center justify-between gap-4 border-b border-line bg-panel px-5 py-3">
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
              {snapshot.routing?.action === "routed" ? (
                <HeaderMetric
                  label="Route"
                  value={`${snapshot.routing.routeSlugs?.[0] ?? "routed"} → ${snapshot.routing.upstreamModel ?? "?"}`}
                />
              ) : null}
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
      ) : displayedSnapshot === undefined ? (
        <EmptyState
          title="No Probes captured"
          detail="Run a trivial Codex prompt through the proxy, then return here."
        />
      ) : (
        <ContextInspector
          snapshot={displayedSnapshot}
          onCreateTransformation={createTransformation}
          disabledIdentifiers={disabledIdentifiers}
          onToggleIdentifier={toggleIdentifier}
        />
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
