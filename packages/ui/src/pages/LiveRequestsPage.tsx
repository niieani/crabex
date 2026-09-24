import { useQuery } from "@tanstack/react-query";
import { Radio } from "lucide-react";

import { EmptyState } from "../features/catalog/ContextInspector.tsx";
import { getLiveRequests } from "../lib/api.ts";
import type { LiveRequest, LiveRequestState } from "../lib/types.ts";

export function LiveRequestsPage() {
  const query = useQuery({
    queryKey: ["live-requests"],
    queryFn: getLiveRequests,
    refetchInterval: 500,
  });

  if (query.isPending) {
    return <EmptyState title="Watching requests" detail="Connecting to the local proxy…" />;
  }
  if (query.isError) {
    return <EmptyState title="Proxy API unavailable" detail={query.error.message} />;
  }

  const active = query.data?.active ?? [];
  const recent = query.data?.recent ?? [];
  return (
    <div className="h-full overflow-y-auto p-6 lg:p-8">
      <div className="mx-auto max-w-6xl">
        <div className="mb-7 flex items-end justify-between gap-4">
          <div>
            <p className="section-label">Live proxy activity</p>
            <h1 className="mt-2 text-2xl font-semibold tracking-tight">Live traffic</h1>
          </div>
          <span
            className={`shrink-0 rounded-full border px-3 py-1 text-xs ${
              active.length > 0
                ? "border-accent/30 bg-accent-dim text-accent"
                : "border-line text-muted"
            }`}
          >
            {active.length} active
          </span>
        </div>

        {active.length === 0 ? (
          <div className="border-y border-line px-6 py-16 text-center">
            <Radio size={30} strokeWidth={1.3} className="mx-auto mb-4 text-accent" />
            <p className="text-sm font-medium">Listening for requests</p>
            <p className="mt-2 text-xs text-muted">No active inference traffic.</p>
          </div>
        ) : (
          <div className="space-y-3">
            {active.map((request) => (
              <RequestCard key={request.id} request={request} active />
            ))}
          </div>
        )}

        {recent.length === 0 ? null : (
          <section className="mt-9">
            <div className="mb-3 flex items-center justify-between">
              <div>
                <p className="section-label">Last minute</p>
                <h2 className="mt-2 text-lg font-semibold">Recently finished</h2>
              </div>
              <span className="text-xs text-muted">Retained for 60 seconds</span>
            </div>
            <div className="space-y-2 opacity-75">
              {recent.map((request) => (
                <RequestCard key={request.id} request={request} active={false} />
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

function RequestCard({ request, active }: { request: LiveRequest; active: boolean }) {
  const host = safeHost(request.upstream);
  const omission = request.events.findLast((event) =>
    event.detail?.startsWith("Omitted tool types:"),
  )?.detail;
  return (
    <article className="rounded-xl border border-line bg-panel p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            {active ? <span className="size-2 animate-pulse rounded-full bg-accent" /> : null}
            <h2 className="font-mono text-sm font-semibold text-content">
              {request.requestedModel ?? "Unknown model"}
            </h2>
            <StateBadge state={request.state} />
          </div>
          <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 font-mono text-[10px] text-muted">
            <span>{request.transport}</span>
            {request.routeSlug === undefined ? (
              <span>default route</span>
            ) : (
              <span>{request.routeSlug}</span>
            )}
            <span title={request.upstream}>→ {host}</span>
            {request.targetModel === undefined ? null : (
              <span className="text-violet">as {request.targetModel}</span>
            )}
            {request.attempt === undefined ? null : (
              <span>
                attempt {request.attempt}/{request.maxAttempts ?? "?"}
              </span>
            )}
            <span>{formatDuration(request.startedAt, request.completedAt)}</span>
          </div>
        </div>
        {request.status === undefined ? null : (
          <span
            className={`rounded px-2 py-1 font-mono text-[10px] ${
              request.status >= 400 ? "bg-danger-dim text-danger" : "bg-canvas text-muted"
            }`}
          >
            HTTP {request.status}
          </span>
        )}
      </div>

      {omission ? (
        <p className="mt-3 rounded-md bg-warning/10 px-3 py-2 text-xs text-warning">{omission}</p>
      ) : null}
      {request.detail === undefined || request.detail === omission ? null : (
        <p
          role={request.state === "failed" ? "alert" : undefined}
          className={`mt-3 text-xs ${request.state === "failed" ? "text-danger" : "text-muted"}`}
        >
          {friendlyDetail(request.detail)}
        </p>
      )}
      {request.brokerUsage ? (
        <p className="mt-3 rounded-md bg-canvas px-3 py-2 font-mono text-[11px] text-content">
          Web search broker {request.brokerUsage.route} · {request.brokerUsage.calls} call(s) ·{" "}
          {request.brokerUsage.inputTokens} in / {request.brokerUsage.outputTokens} out tokens
          {request.brokerUsage.errors ? ` · ${request.brokerUsage.errors} error(s)` : ""}
        </p>
      ) : null}
      {request.events.length <= 1 ? null : (
        <div className="mt-4 flex flex-wrap items-center gap-1.5 border-t border-line/60 pt-3">
          {request.events.map((event, index) => (
            <div key={`${event.at}-${index}`} className="flex items-center gap-1.5">
              {index === 0 ? null : <span className="text-[10px] text-line">→</span>}
              <span
                title={`${new Date(event.at).toLocaleTimeString()}${event.detail === undefined ? "" : ` · ${event.detail}`}`}
                className={`rounded-full px-2 py-1 font-mono text-[9px] ${stateClasses(event.state)}`}
              >
                {stateLabel(event.state)}
                {event.targetModel === undefined ? "" : ` · ${shortModel(event.targetModel)}`}
                {event.attempt === undefined ? "" : ` #${event.attempt}`}
                {event.status === undefined ? "" : ` · ${event.status}`}
              </span>
            </div>
          ))}
        </div>
      )}
    </article>
  );
}

function StateBadge({ state }: { state: LiveRequestState }) {
  return (
    <span className={`rounded-full px-2 py-1 text-[10px] font-semibold ${stateClasses(state)}`}>
      {stateLabel(state)}
    </span>
  );
}

function stateLabel(state: LiveRequestState): string {
  return state.replace("-", " ");
}

function stateClasses(state: LiveRequestState): string {
  if (state === "failed") return "bg-danger-dim text-danger";
  if (state === "retrying" || state === "falling-back") return "bg-violet-dim text-violet";
  if (state === "completed") return "bg-canvas text-muted";
  return "bg-accent-dim text-accent";
}

function safeHost(value: string): string {
  try {
    const url = new URL(value);
    return `${url.host}${url.pathname}`;
  } catch {
    return value;
  }
}

function shortModel(value: string): string {
  const pieces = value.split(".");
  return pieces[pieces.length - 1] ?? value;
}

function formatDuration(startedAt: string, completedAt?: string): string {
  const end = completedAt === undefined ? Date.now() : Date.parse(completedAt);
  const milliseconds = Math.max(0, end - Date.parse(startedAt));
  return milliseconds < 1000 ? `${milliseconds}ms` : `${(milliseconds / 1000).toFixed(1)}s`;
}

function friendlyDetail(detail: string): string {
  if (detail === "served") return "The upstream accepted this request and is streaming a response.";
  if (detail === "retry") return "The target asked us to retry this request.";
  if (detail === "failover") return "The target cannot serve this model; moving to the fallback.";
  if (detail === "network-error")
    return "The target could not be reached; moving to the next attempt.";
  return detail;
}
