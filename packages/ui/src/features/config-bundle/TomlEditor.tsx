import { useEffect, useRef } from "react";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap, lineNumbers } from "@codemirror/view";
import { StreamLanguage, syntaxHighlighting, defaultHighlightStyle } from "@codemirror/language";
import { toml } from "@codemirror/legacy-modes/mode/toml";
import { indentWithTab } from "@codemirror/commands";
import { linter } from "@codemirror/lint";
import { parse, TomlError } from "smol-toml";

export function tomlError(contents: string): string | undefined {
  try {
    parse(contents);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export function TomlEditor({
  value,
  onChange,
  readOnly = false,
  label,
}: {
  value: string;
  onChange?: (value: string) => void;
  readOnly?: boolean;
  label: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<EditorView | null>(null);
  const change = useRef(onChange);
  change.current = onChange;
  useEffect(() => {
    if (!host.current) return;
    const view = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          StreamLanguage.define(toml),
          syntaxHighlighting(defaultHighlightStyle),
          keymap.of([indentWithTab]),
          EditorState.readOnly.of(readOnly),
          EditorView.editable.of(!readOnly),
          EditorView.contentAttributes.of({ "aria-label": label }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) change.current?.(update.state.doc.toString());
          }),
          linter((view) => {
            try {
              parse(view.state.doc.toString());
              return [];
            } catch (error) {
              const line = error instanceof TomlError ? error.line : 1;
              const column = error instanceof TomlError ? error.column : 1;
              const location = view.state.doc.line(
                Math.max(1, Math.min(line, view.state.doc.lines)),
              );
              const from = Math.min(location.to, location.from + Math.max(0, column - 1));
              return [
                {
                  from,
                  to: Math.min(from + 1, view.state.doc.length),
                  severity: "error",
                  message: error instanceof Error ? error.message : String(error),
                },
              ];
            }
          }),
          EditorView.theme(
            {
              "&": {
                backgroundColor: "var(--color-canvas, #101217)",
                color: "var(--color-content, #ddd)",
                fontSize: "12px",
              },
              ".cm-scroller": { overflow: "auto", maxHeight: "360px", fontFamily: "monospace" },
              ".cm-content": { minHeight: "100px" },
              ".cm-gutters": { backgroundColor: "transparent", color: "#808895", border: "none" },
              ".cm-cursor": { borderLeftColor: "#ddd" },
            },
            { dark: true },
          ),
        ],
      }),
    });
    editor.current = view;
    return () => {
      view.destroy();
      editor.current = null;
    };
    // Value changes are synchronized without recreating selection and undo state.
  }, [readOnly, label]);
  useEffect(() => {
    const view = editor.current;
    if (view && view.state.doc.toString() !== value)
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
  }, [value]);
  return <div ref={host} className="overflow-hidden rounded-md border border-line" />;
}
