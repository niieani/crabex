import { classifyMessage } from "../context/classification.ts";
import type {
  CaptureDirection,
  CaptureMessageObservation,
  CaptureRequestSummary,
  CaptureResponseSummary,
  CaptureUsage,
} from "./capture.ts";

export interface PayloadObservation {
  eventType?: string;
  requestSummary?: CaptureRequestSummary;
  responseSummary?: CaptureResponseSummary;
  /**
   * Codex conversation scope for retention latching: `client_metadata`'s
   * thread_id (falling back to session_id) on response.create payloads.
   */
  sessionKey?: string;
}

export function observePayload(payload: string, direction: CaptureDirection): PayloadObservation {
  const value = parseObject(payload);
  if (value === undefined) return {};

  const eventType = stringValue(value.type);
  if (direction === "client_to_upstream" && eventType === "response.create") {
    const sessionKey = sessionKeyOf(value);
    return {
      eventType,
      requestSummary: requestSummary(value),
      ...(sessionKey === undefined ? {} : { sessionKey }),
    };
  }
  if (direction === "upstream_to_client" && eventType === "response.completed") {
    return { eventType, responseSummary: responseSummary(value) };
  }
  return eventType === undefined ? {} : { eventType };
}

function sessionKeyOf(value: Record<string, unknown>): string | undefined {
  const metadata = objectValue(value.client_metadata);
  return stringValue(metadata?.thread_id) ?? stringValue(metadata?.session_id);
}

function requestSummary(value: Record<string, unknown>): CaptureRequestSummary {
  const input = value.input;
  return {
    type: "response.create",
    ...(stringValue(value.model) === undefined ? {} : { model: value.model as string }),
    ...(typeof value.generate === "boolean" ? { generate: value.generate } : {}),
    ...(stringValue(value.previous_response_id) === undefined
      ? {}
      : { previousResponseId: value.previous_response_id as string }),
    messages: messageObservations(input),
    hasRealUserMessage: hasRealUserMessage(input),
  };
}

function responseSummary(value: Record<string, unknown>): CaptureResponseSummary {
  const response = objectValue(value.response);
  return {
    type: "response.completed",
    ...(stringValue(response?.id) === undefined ? {} : { id: response?.id as string }),
    ...(stringValue(response?.previous_response_id) === undefined
      ? {}
      : { previousResponseId: response?.previous_response_id as string }),
    ...(usageValue(response?.usage) === undefined ? {} : { usage: usageValue(response?.usage) }),
  };
}

function messageObservations(input: unknown): CaptureMessageObservation[] {
  if (typeof input === "string") {
    return [{ path: "input", role: "user", characters: input.length }];
  }
  if (!Array.isArray(input)) return [];

  const messages: CaptureMessageObservation[] = [];
  for (const [inputIndex, inputValue] of input.entries()) {
    const item = objectValue(inputValue);
    if (item?.type !== "message" || !Array.isArray(item.content)) continue;
    const role = stringValue(item.role);
    for (const [contentIndex, contentValue] of item.content.entries()) {
      const content = objectValue(contentValue);
      const text = stringValue(content?.text);
      if (text === undefined) continue;
      const classification = classifyMessage(role, text);
      messages.push({
        path: `input[${inputIndex}].content[${contentIndex}].text`,
        ...(role === undefined ? {} : { role }),
        ...(classification === undefined
          ? {}
          : {
              classificationId: classification.id,
              classificationLabel: classification.label,
            }),
        characters: text.length,
      });
    }
  }
  return messages;
}

function hasRealUserMessage(input: unknown): boolean {
  if (typeof input === "string") return true;
  if (!Array.isArray(input)) return false;

  for (const inputValue of input) {
    const item = objectValue(inputValue);
    if (item?.type !== "message" || item.role !== "user") continue;
    if (!Array.isArray(item.content) || item.content.length === 0) return true;
    if (
      item.content.some((contentValue) => {
        const text = stringValue(objectValue(contentValue)?.text);
        return text === undefined || classifyMessage("user", text) === undefined;
      })
    ) {
      return true;
    }
  }
  return false;
}

function parseObject(value: string): Record<string, unknown> | undefined {
  try {
    return objectValue(JSON.parse(value));
  } catch {
    return undefined;
  }
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function usageValue(value: unknown): CaptureUsage | undefined {
  const usage = objectValue(value);
  if (typeof usage?.input_tokens !== "number") return undefined;
  const details = objectValue(usage.input_tokens_details);
  return {
    inputTokens: usage.input_tokens,
    cachedTokens: typeof details?.cached_tokens === "number" ? details.cached_tokens : 0,
  };
}
