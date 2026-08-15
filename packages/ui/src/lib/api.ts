import type { ContextSnapshot, TransformationSet, TransformationTelemetry } from "./types.ts";

const API = "/__agent-context-trimmer/api";

export async function getSnapshots(): Promise<ContextSnapshot[]> {
  const response = await request(`${API}/snapshots`);
  return ((await response.json()) as { snapshots: ContextSnapshot[] }).snapshots;
}

export async function getTransformations(): Promise<TransformationSet> {
  const response = await request(`${API}/transformations`);
  return (await response.json()) as TransformationSet;
}

export async function putTransformations(set: TransformationSet): Promise<TransformationSet> {
  const response = await request(`${API}/transformations`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(set),
  });
  return (await response.json()) as TransformationSet;
}

export async function getTransformationTelemetry(): Promise<TransformationTelemetry[]> {
  const response = await request(`${API}/transformation-telemetry`);
  return ((await response.json()) as { telemetry: TransformationTelemetry[] }).telemetry;
}

export async function previewSnapshot(
  snapshotId: string,
  transformations: TransformationSet["transformations"],
): Promise<ContextSnapshot> {
  const response = await request(`${API}/preview`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ snapshotId, transformations }),
  });
  return ((await response.json()) as { snapshot: ContextSnapshot }).snapshot;
}

async function request(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const response = await fetch(input, init);
  if (response.ok) return response;
  const body = (await response.json().catch(() => undefined)) as { error?: string } | undefined;
  throw new Error(body?.error ?? `request failed: ${response.status}`);
}
