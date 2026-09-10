import { classifyMessage } from "./classification.ts";

/**
 * A string field inside a model definition's `model_messages` tree. These are
 * the instruction templates Codex renders into request payloads, so they share
 * identifiers with their request-rendered counterparts whenever the content
 * classifier recognizes them.
 */
export interface ModelStringField {
  /** Path segments from the model object root, e.g. ["model_messages", "token_budget", "guidance_message"]. */
  path: Array<string | number>;
  /** Dotted path used as the part path, e.g. "model_messages.token_budget.guidance_message". */
  dotPath: string;
  text: string;
  /** Classification id (e.g. "segment:codex_base") or a path-based fallback ("model:<dotPath>"). */
  identifier: string;
  /** Classification label or a humanized path segment. */
  label: string;
  /** The classification id when recognized, undefined otherwise. Used for segment scoping. */
  classificationId?: string;
}

/** Extracts every non-empty string leaf under `model_messages`. */
export function modelStringFields(model: Record<string, unknown>): ModelStringField[] {
  const messages = model.model_messages;
  if (typeof messages !== "object" || messages === null || Array.isArray(messages)) return [];
  const fields: ModelStringField[] = [];
  collectFields(messages as Record<string, unknown>, ["model_messages"], fields);
  return fields;
}

/** Sets a value at a path produced by {@link modelStringFields}. */
export function setModelField(
  model: Record<string, unknown>,
  path: Array<string | number>,
  value: unknown,
): void {
  let target: Record<string, unknown> | unknown[] = model;
  for (let index = 0; index < path.length - 1; index += 1) {
    const segment = path[index];
    const next = (target as Record<string, unknown>)[segment as string];
    if (typeof next !== "object" || next === null) return;
    target = next as Record<string, unknown> | unknown[];
  }
  (target as Record<string, unknown>)[path[path.length - 1] as string] = value;
}

function collectFields(
  value: Record<string, unknown>,
  path: Array<string | number>,
  fields: ModelStringField[],
): void {
  for (const [key, child] of Object.entries(value)) {
    const childPath = [...path, key];
    if (typeof child === "string") {
      if (child.trim() !== "") fields.push(stringField(childPath, child));
    } else if (Array.isArray(child)) {
      child.forEach((item, index) => {
        if (typeof item === "string") {
          if (item.trim() !== "") fields.push(stringField([...childPath, index], item));
        } else if (typeof item === "object" && item !== null) {
          collectFields(item as Record<string, unknown>, [...childPath, index], fields);
        }
      });
    } else if (typeof child === "object" && child !== null) {
      collectFields(child as Record<string, unknown>, childPath, fields);
    }
  }
}

function stringField(path: Array<string | number>, text: string): ModelStringField {
  const dotPath = dotPathOf(path);
  const classification = classifyMessage("developer", text);
  return {
    path,
    dotPath,
    text,
    identifier: classification?.id ?? `model:${dotPath}`,
    label: classification?.label ?? humanize(path[path.length - 1]),
    ...(classification === undefined ? {} : { classificationId: classification.id }),
  };
}

function dotPathOf(path: Array<string | number>): string {
  return path
    .map((segment) => (typeof segment === "number" ? `[${segment}]` : segment))
    .join(".")
    .replaceAll(".[", "[");
}

function humanize(segment: string | number): string {
  const raw = String(segment);
  const spaced = raw.replaceAll(/[_-]+/g, " ").trim();
  if (spaced === "") return raw;
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
