import type {
  CodexConfigState,
  ConfigBundleOverride,
  ContextSnapshot,
  ModelRouteSet,
  ModelsFixture,
  RoutingTelemetry,
  TransformationSet,
  TransformationTelemetry,
  UpstreamCacheState,
} from "./types.ts";

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

export async function getRoutingTelemetry(): Promise<{
  telemetry: RoutingTelemetry[];
  breakers: Record<string, string>;
}> {
  const response = await request(`${API}/routing-telemetry`);
  const body = (await response.json()) as {
    telemetry: RoutingTelemetry[];
    breakers?: Record<string, string>;
  };
  return { telemetry: body.telemetry, breakers: body.breakers ?? {} };
}

export async function resetStats(): Promise<void> {
  await request(`${API}/stats/reset`, { method: "POST" });
}

export async function getUpstreamCache(): Promise<UpstreamCacheState> {
  const response = await request(`${API}/upstream-cache`);
  return (await response.json()) as UpstreamCacheState;
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

export async function getModelRoutes(): Promise<ModelRouteSet> {
  const response = await request(`${API}/model-routes`);
  return (await response.json()) as ModelRouteSet;
}

export async function putModelRoutes(set: ModelRouteSet): Promise<ModelRouteSet> {
  const response = await request(`${API}/model-routes`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(set),
  });
  return (await response.json()) as ModelRouteSet;
}

export async function getModelRouteEnvStatus(): Promise<Record<string, boolean>> {
  const response = await request(`${API}/model-routes/env-status`);
  return ((await response.json()) as { env: Record<string, boolean> }).env;
}

export async function getModelsFixture(): Promise<ModelsFixture> {
  const response = await request(`${API}/models-fixture`);
  return (await response.json()) as ModelsFixture;
}

export async function getConfigBundle(): Promise<ConfigBundleOverride> {
  const response = await request(`${API}/config-bundle`);
  return (await response.json()) as ConfigBundleOverride;
}

export async function putConfigBundle(
  override: ConfigBundleOverride,
): Promise<ConfigBundleOverride> {
  const response = await request(`${API}/config-bundle`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(override),
  });
  return (await response.json()) as ConfigBundleOverride;
}

export async function deleteConfigBundle(): Promise<ConfigBundleOverride> {
  const response = await request(`${API}/config-bundle`, { method: "DELETE" });
  return (await response.json()) as ConfigBundleOverride;
}

export async function getCodexConfig(): Promise<CodexConfigState> {
  const response = await request(`${API}/codex-config`);
  return (await response.json()) as CodexConfigState;
}

export async function putCodexConfig(key: string, enabled: boolean): Promise<CodexConfigState> {
  const response = await request(`${API}/codex-config`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key, enabled }),
  });
  return (await response.json()) as CodexConfigState;
}

async function request(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const response = await fetch(input, init);
  if (response.ok) return response;
  const body = (await response.json().catch(() => undefined)) as { error?: string } | undefined;
  throw new Error(body?.error ?? `request failed: ${response.status}`);
}
