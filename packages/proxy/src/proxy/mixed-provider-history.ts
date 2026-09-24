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

/** Keep provider-owned reasoning out of another provider's fork or replay. */
export function sanitizeMixedProviderHistory(
  payload: JsonObject,
  options: { target: "native" | "responses" | "anthropic"; sourceModel?: string },
): JsonObject {
  if (!Array.isArray(payload.input)) return payload;
  const crossModel = options.sourceModel !== undefined && options.sourceModel !== payload.model;
  const currentPath = payload.input.findLast(newTask)?.recipient;
  const taskIndex = payload.input.findIndex(
    (item) => newTask(item) && item.recipient === currentPath,
  );
  let changed = false;
  const input = payload.input.filter((item, index) => {
    if (!record(item) || (item.type !== "reasoning" && item.type !== "compaction")) return true;
    const foreignForkItem = crossModel && (taskIndex < 0 || index < taskIndex);
    const foreignEnvelope =
      options.target === "anthropic"
        ? !anthropicState(item.encrypted_content)
        : options.target === "responses"
          ? typeof item.encrypted_content === "string"
          : anthropicState(item.encrypted_content);
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
