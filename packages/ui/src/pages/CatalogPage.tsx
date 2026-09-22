import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useDeferredValue, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronLeft,
  ChevronRight,
  Layers3,
  Pause,
  Play,
  RefreshCw,
  Search,
  WandSparkles,
} from "lucide-react";
import { ContextInspector, EmptyState } from "../features/catalog/ContextInspector.tsx";
import {
  getSnapshot,
  getSnapshotIndex,
  getTransformations,
  previewSnapshot,
  putTransformations,
} from "../lib/api.ts";
import type { Transformation } from "../lib/types.ts";

export function CatalogPage() {
  const queryClient = useQueryClient();
  const { capture: selectedId } = useSearch({ from: "/" });
  const navigate = useNavigate({ from: "/" });
  const [search, setSearch] = useState("");
  const needle = useDeferredValue(search.toLowerCase());
  const [harness, setHarness] = useState("all");
  const [live, setLive] = useState(true);
  const [preview, setPreview] = useState(false);
  const snapshotsQuery = useQuery({
    queryKey: ["snapshot-index"],
    queryFn: ({ signal }) => getSnapshotIndex(signal),
    refetchInterval: live ? 5000 : false,
  });
  const transformationsQuery = useQuery({
    queryKey: ["transformations"],
    queryFn: getTransformations,
  });
  const snapshots = snapshotsQuery.data ?? [];
  const revision = snapshots.find((item) => item.id === selectedId)?.revision;
  const filtered = snapshots.filter(
    (item) =>
      (harness === "all" || item.harness.kind === harness) &&
      `${item.model} ${item.project ?? ""} ${item.sessionId} ${item.harness.kind}`
        .toLowerCase()
        .includes(needle),
  );
  const snapshotQuery = useQuery({
    queryKey: ["snapshot", selectedId, revision],
    queryFn: ({ signal }) => getSnapshot(selectedId!, signal),
    enabled: selectedId !== undefined,
    staleTime: 30000,
    gcTime: 60000,
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[1] === selectedId ? previous : undefined,
  });
  const previewQuery = useQuery({
    queryKey: ["preview", selectedId, revision, transformationsQuery.data?.transformations],
    queryFn: () => previewSnapshot(selectedId!, transformationsQuery.data!.transformations),
    enabled: preview && selectedId !== undefined && transformationsQuery.data !== undefined,
  });
  const snapshot = preview ? (previewQuery.data ?? snapshotQuery.data) : snapshotQuery.data;
  const mutation = useMutation({
    mutationFn: putTransformations,
    onSuccess: (set) => {
      queryClient.setQueryData(["transformations"], set);
      setPreview(true);
    },
  });
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

  function select(id: string | undefined) {
    void navigate({ search: { capture: id } });
    setPreview(false);
    mutation.reset();
  }
  function createTransformation(transformation: Transformation) {
    const current = transformationsQuery.data;
    if (current)
      return mutation.mutateAsync({
        version: 1,
        transformations: [...current.transformations, transformation],
      });
  }
  function toggleIdentifier(identifier: string, disabled: boolean) {
    const current = transformationsQuery.data;
    if (!current || mutation.isPending) return;
    const id = `disable:${identifier}`;
    const remaining = current.transformations.filter((rule) => rule.id !== id);
    mutation.mutate({
      version: 1,
      transformations: disabled
        ? [
            ...remaining,
            {
              id,
              name: `Disable ${identifier}`,
              enabled: true,
              scope: {},
              target: {
                field: /^(tool:|registry:|registry-group:)/.test(identifier)
                  ? "tool"
                  : "message_text",
                identifier,
              },
              operation: { type: "delete_part" },
            },
          ]
        : remaining,
    });
  }

  const position = filtered.findIndex((item) => item.id === selectedId);
  const error =
    snapshotsQuery.error ??
    transformationsQuery.error ??
    snapshotQuery.error ??
    (preview ? previewQuery.error : null) ??
    mutation.error;
  return (
    <div className="catalog-page">
      {selectedId === undefined ? (
        <>
          <header className="page-heading">
            <div>
              <div className="eyebrow">OBSERVABILITY</div>
              <h1>Captures</h1>
              <p>Every agent request, open for inspection.</p>
            </div>
            <div className="toolbar">
              <button className="subtle-button" onClick={() => setLive(!live)}>
                {live ? <Pause size={15} /> : <Play size={15} />}
                {live ? "Live" : "Paused"}
                <span className={`status-dot ${live ? "" : "paused"}`} />
              </button>
              <button
                className="icon-button"
                aria-label="Refresh captures"
                title="Refresh captures"
                disabled={snapshotsQuery.isFetching}
                onClick={() => void snapshotsQuery.refetch()}
              >
                <RefreshCw size={17} className={snapshotsQuery.isFetching ? "animate-spin" : ""} />
              </button>
            </div>
          </header>
          <div className="capture-metrics">
            <Metric label="Retained captures" value={format(snapshots.length)} />
            <Metric
              label="Models observed"
              value={format(new Set(snapshots.map((item) => item.model)).size)}
            />
            <Metric
              label="Input tokens"
              value={compact(
                snapshots.reduce((sum, item) => sum + (item.usage?.inputTokens ?? 0), 0),
              )}
            />
            <Metric label="Cache hit rate" value={cacheRate(snapshots)} />
          </div>
          <div className="capture-filters">
            <label className="search-field">
              <Search size={17} />
              <input
                type="search"
                aria-label="Search captures"
                placeholder="Search model, project or session..."
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </label>
            <select
              aria-label="Filter harness"
              className="filter-select"
              value={harness}
              onChange={(event) => setHarness(event.target.value)}
            >
              <option value="all">All harnesses</option>
              <option value="desktop">Desktop</option>
              <option value="tui">Terminal</option>
              <option value="unknown">Unknown</option>
              <option value="conflicted">Conflicted</option>
            </select>
            <span className="result-count">{filtered.length} captures</span>
          </div>
          {snapshotsQuery.isPending ? (
            <EmptyState title="Loading captures" detail="Indexing recorded requests..." />
          ) : filtered.length === 0 ? (
            <div className="capture-empty">
              <Layers3 size={32} strokeWidth={1.3} />
              <h2>{snapshots.length ? "No matching captures" : "Ready for your first request"}</h2>
              <p>
                {snapshots.length
                  ? "Try another model, project or harness."
                  : "Captured requests will appear here when an agent connects to the proxy."}
              </p>
              {snapshots.length ? (
                <button
                  className="subtle-button"
                  onClick={() => {
                    setSearch("");
                    setHarness("all");
                  }}
                >
                  Clear filters
                </button>
              ) : null}
            </div>
          ) : (
            <div className="capture-table-scroll">
              <table className="capture-table">
                <thead>
                  <tr>
                    <th>Model / session</th>
                    <th>Harness</th>
                    <th>Project</th>
                    <th>Input tokens</th>
                    <th>Captured</th>
                    <th>
                      <span className="sr-only">Open</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((item) => (
                    <tr key={item.id}>
                      <td>
                        <button className="capture-open" onClick={() => select(item.id)}>
                          <span className="capture-avatar">
                            <Layers3 size={18} />
                          </span>
                          <span>
                            <strong>{item.model || "Unknown model"}</strong>
                            <small>
                              {item.sessionId.slice(0, 18)}
                              <span className="text-muted"> / {item.partCount} parts</span>
                            </small>
                          </span>
                        </button>
                      </td>
                      <td>
                        <span className={`harness-badge ${item.harness.kind}`}>
                          {item.harness.kind === "tui" ? "terminal" : item.harness.kind}
                        </span>
                      </td>
                      <td className="project-cell" title={item.project}>
                        {item.project?.split("/").filter(Boolean).pop() ?? "Unscoped"}
                      </td>
                      <td className="tabular-nums">
                        {item.usage ? (
                          format(item.usage.inputTokens)
                        ) : (
                          <span className="text-muted">Pending</span>
                        )}
                      </td>
                      <td
                        className="timestamp-cell"
                        title={new Date(item.timestamp).toLocaleString()}
                      >
                        {new Date(item.timestamp).toLocaleDateString(undefined, {
                          month: "short",
                          day: "numeric",
                        })}
                        <small>
                          {new Date(item.timestamp).toLocaleTimeString(undefined, {
                            hour: "2-digit",
                            minute: "2-digit",
                            second: "2-digit",
                          })}
                        </small>
                      </td>
                      <td>
                        <button
                          className="icon-button"
                          title={`Inspect ${item.model}`}
                          aria-label={`Inspect ${item.model} ${item.id}`}
                          onClick={() => select(item.id)}
                        >
                          <ArrowRight size={17} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <footer className="catalog-footer">
            <span>Newest first</span>
            <span>
              {snapshotsQuery.dataUpdatedAt
                ? `Updated ${new Date(snapshotsQuery.dataUpdatedAt).toLocaleTimeString()}`
                : "Connecting to proxy"}
            </span>
          </footer>
        </>
      ) : (
        <>
          <header className="inspection-heading">
            <button className="subtle-button" onClick={() => select(undefined)}>
              <ArrowLeft size={16} />
              Captures
            </button>
            <span className="heading-divider" />
            <div className="inspection-title">
              <strong>{snapshotQuery.data?.model ?? "Loading capture"}</strong>
              <small>
                {snapshotQuery.data
                  ? new Date(snapshotQuery.data.timestamp).toLocaleString()
                  : selectedId}
              </small>
            </div>
            <div className="toolbar">
              <button
                className={`subtle-button ${preview ? "selected" : ""}`}
                disabled={!transformationsQuery.data}
                onClick={() => setPreview(!preview)}
              >
                <WandSparkles size={15} />
                {preview
                  ? previewQuery.isFetching
                    ? "Updating preview..."
                    : "Previewing rules"
                  : "Preview rules"}
              </button>
              <button
                className="icon-button"
                aria-label="Previous capture"
                title="Previous capture"
                disabled={position <= 0}
                onClick={() => select(filtered[position - 1]?.id)}
              >
                <ChevronLeft size={17} />
              </button>
              <button
                className="icon-button"
                aria-label="Next capture"
                title="Next capture"
                disabled={position < 0 || position >= filtered.length - 1}
                onClick={() => select(filtered[position + 1]?.id)}
              >
                <ChevronRight size={17} />
              </button>
            </div>
          </header>
          {snapshot === undefined ? (
            <EmptyState
              title={preview ? "Previewing transformations" : "Opening capture"}
              detail="Loading context parts..."
            />
          ) : (
            <ContextInspector
              key={snapshot.id}
              snapshot={snapshot}
              onCreateTransformation={createTransformation}
              disabledIdentifiers={disabledIdentifiers}
              onToggleIdentifier={toggleIdentifier}
            />
          )}
        </>
      )}
      {error ? (
        <div className="feedback error" role="alert">
          {error.message}
          <button
            className="subtle-button"
            onClick={() => {
              void snapshotsQuery.refetch();
              if (selectedId) void snapshotQuery.refetch();
              if (preview) void previewQuery.refetch();
              mutation.reset();
            }}
          >
            Retry
          </button>
        </div>
      ) : mutation.isSuccess ? (
        <div className="feedback" role="status">
          <Check size={16} />
          Transformation saved
          <button className="subtle-button" onClick={() => mutation.reset()}>
            Dismiss
          </button>
        </div>
      ) : null}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
function format(value: number) {
  return new Intl.NumberFormat().format(value);
}
function compact(value: number) {
  return new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(
    value,
  );
}
function cacheRate(items: { usage?: { inputTokens: number; cachedTokens: number } }[]) {
  const input = items.reduce((sum, item) => sum + (item.usage?.inputTokens ?? 0), 0);
  return input
    ? `${Math.round((items.reduce((sum, item) => sum + (item.usage?.cachedTokens ?? 0), 0) / input) * 100)}%`
    : "--";
}
