type JsonObject = Record<string, unknown>;

const record = (value: unknown): value is JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export class UnreadableAgentMessage extends Error {}

/** Give custom providers a readable user turn while retaining the agent envelope. */
export function prepareCustomAgentMessages(
  payload: JsonObject,
  routeSlug: string,
  plaintextHandoffEnabled = false,
): JsonObject {
  if (!Array.isArray(payload.input)) return payload;
  let changed = false;
  const input = payload.input.map((raw) => {
    if (!record(raw) || raw.type !== "agent_message") return raw;
    const fail = (detail: string): never => {
      throw new UnreadableAgentMessage(`model route "${routeSlug}" ${detail}`);
    };
    const content = raw.content;
    if (!Array.isArray(content)) return fail("has an invalid V2 agent_message");
    if (content.some((part: unknown) => record(part) && part.type === "encrypted_content"))
      return fail(
        `cannot read encrypted V2 agent_message; refusing to forward. ${plaintextHandoffEnabled ? "Use routed_agents plaintext tools when messaging a routed custom-model agent." : "Enable proxy routed_agents.enabled to offer native agents plaintext tools for routed custom-model targets."}`,
      );
    const author = raw.author;
    const recipient = raw.recipient;
    if (typeof author !== "string" || typeof recipient !== "string")
      return fail("has a V2 agent_message without sender or recipient");
    const parts = content.map((part: unknown): string => {
      if (!record(part) || part.type !== "input_text" || typeof part.text !== "string")
        return fail("has an unsupported V2 agent_message content part");
      return part.text;
    });
    if (parts.every((part) => part.length === 0)) return fail("has an empty V2 agent_message");
    changed = true;
    return {
      type: "message",
      role: "user",
      content: [
        {
          type: "input_text",
          text: `Agent message from ${author} to ${recipient}:\n${parts.join("\n")}`,
        },
      ],
    };
  });
  return changed ? { ...payload, input } : payload;
}
