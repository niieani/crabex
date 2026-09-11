import type { ModelDefinition } from "./model-list.ts";
import fixture from "./models-fixture.json";

let cached: ModelDefinition[] | undefined;

/**
 * The model catalog baked into the proxy (a captured upstream /models
 * response). Used as a template source for model routes and as a pin target
 * for serving the fixture version of a model in place of the fetched one.
 */
export function modelsFixture(): ModelDefinition[] {
  cached ??= parseModels(fixture);
  return cached;
}

function parseModels(value: unknown): ModelDefinition[] {
  if (typeof value !== "object" || value === null) return [];
  const models = (value as { models?: unknown }).models;
  if (!Array.isArray(models)) return [];
  return models.filter(
    (model): model is ModelDefinition =>
      typeof model === "object" &&
      model !== null &&
      typeof (model as { slug?: unknown }).slug === "string",
  );
}
