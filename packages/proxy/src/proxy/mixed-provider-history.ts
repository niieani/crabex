import { createHash } from "node:crypto";
import type { ModelRoute } from "../routing/model-routes.ts";

type JsonObject = Record<string, unknown>;

const record = (value: unknown): value is JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const anthropicState = (value: unknown) => typeof value === "string" && value.startsWith("acta1:");
const newTask = (item: unknown): item is JsonObject =>
  record(item) &&
  item.type === "agent_message" &&
  typeof item.recipient === "string" &&
  Array.isArray(item.content) &&
  item.content.some(
    (part) =>
      record(part) &&
      part.type === "input_text" &&
      typeof part.text === "string" &&
      part.text.startsWith("Message Type: NEW_TASK"),
  );

export class ForeignHistoryError extends Error {}

/** The account-scoped registry keeps native threads apart; their models share a backend. */
export const NATIVE_REASONING_FAMILY = "native-chatgpt";

/** Hash provider identity so persistent lineage state never stores credentials. */
export function routedReasoningFamily(
  route: ModelRoute,
  environment: Readonly<Record<string, string | undefined>>,
  anthropicKey: Uint8Array,
): string | undefined {
  const credential = environment[route.authorizationEnv];
  if (!credential) return undefined;
  const hash = createHash("sha256");
  if (route.api === "anthropic-messages") {
    // Include the AnthropicEnvelope AAD scope; open() also authenticates that scope.
    hash.update(JSON.stringify([route.model.slug, route.upstream.href, credential]));
    hash.update(anthropicKey);
    return `anthropic:${hash.digest("hex")}`;
  }
  const upstream = route.upstream;
  hash.update(
    JSON.stringify([
      upstream.origin,
      upstream.pathname.replace(/\/+$/, ""),
      upstream.search,
      credential,
    ]),
  );
  return `responses:${hash.digest("hex")}`;
}

/** Keep provider-owned reasoning out of another provider's fork or replay. */
export function sanitizeMixedProviderHistory(
  payload: JsonObject,
  options: {
    target: "native" | "responses" | "anthropic";
    targetFamily?: string;
    sourceFamily?: string;
  },
): JsonObject {
  if (!Array.isArray(payload.input)) return payload;
  const currentPath = payload.input.findLast(newTask)?.recipient;
  const taskIndex = payload.input.findIndex(
    (item) => newTask(item) && item.recipient === currentPath,
  );
  const crossFamilyFork =
    taskIndex >= 0 &&
    options.sourceFamily !== undefined &&
    options.targetFamily !== undefined &&
    options.sourceFamily !== options.targetFamily;
  let changed = false;
  const input = payload.input.filter((item, index) => {
    if (!record(item) || (item.type !== "reasoning" && item.type !== "compaction")) return true;
    const foreignForkItem = crossFamilyFork && index < taskIndex;
    const foreignEnvelope =
      options.target !== "anthropic" && anthropicState(item.encrypted_content);
    if (!foreignForkItem && !foreignEnvelope) return true;
    if (item.type === "compaction")
      throw new ForeignHistoryError(
        "Cannot transfer another provider's opaque compaction to this model; start the child with fork_turns none.",
      );
    changed = true;
    return false;
  });
  return changed ? { ...payload, input } : payload;
}
