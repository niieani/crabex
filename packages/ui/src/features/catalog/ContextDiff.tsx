import { preloadHighlighter } from "@pierre/diffs";
import { Editor, type EditorOptions } from "@pierre/diffs/edit";
import { EditProvider, File, MultiFileDiff } from "@pierre/diffs/react";
import { Suspense, use, useCallback, useEffect, useMemo, useRef } from "react";

import type { JsonPathSegment } from "../../lib/types.ts";
import type { TextRange } from "./json-selection.ts";

export interface TransformSelection {
  find: string;
  jsonPath?: JsonPathSegment[];
}

interface ContextDiffProps {
  original?: string;
  effective: string;
  filename: string;
  search: string;
  highlightRange?: TextRange;
  onTransformSelection: (selection: TransformSelection) => void;
  resolveTransformSelection?: (selection: {
    text: string;
    range: TextRange;
  }) => TransformSelection | undefined;
}

const contextDiffHighlighterReady = preloadHighlighter({
  langs: ["json", "markdown", "javascript", "typescript", "jsx", "tsx"],
  themes: ["pierre-dark"],
});

export function ContextDiff(props: ContextDiffProps) {
  return (
    <Suspense
      fallback={
        <p className="p-4 text-xs text-muted" role="status">
          Preparing syntax highlighting...
        </p>
      }
    >
      <ReadyContextDiff {...props} />
    </Suspense>
  );
}

function ReadyContextDiff({
  original,
  effective,
  filename,
  search,
  highlightRange,
  onTransformSelection,
  resolveTransformSelection,
}: ContextDiffProps) {
  use(contextDiffHighlighterReady);
  const editorRef = useRef<Editor<undefined>>(undefined);
  const createEditor = useCallback((options: EditorOptions<undefined>) => new Editor(options), []);
  const editorOptions = useMemo<EditorOptions<undefined>>(
    () => ({
      readOnly: true,
      enabledSelectionAction: true,
      onAttach(editor) {
        editorRef.current = editor as Editor<undefined>;
        editorRef.current.setMarkers(markersForSearch(effective, search));
        setSelectionIfAttached(editorRef.current, highlightRange);
      },
      renderSelectionAction(context) {
        const selected = () => ({
          text: context.getSelectionText(),
          range: context.selection,
        });
        const resolved = () =>
          resolveTransformSelection?.(selected()) ??
          (resolveTransformSelection === undefined
            ? { find: context.getSelectionText() }
            : undefined);
        const button = document.createElement("button");
        button.type = "button";
        const initial = resolved();
        button.textContent = initial === undefined ? "Select one JSON string" : "Transform";
        button.disabled = initial === undefined;
        if (initial === undefined) {
          button.title = "The selection must be inside one JSON string value.";
        }
        button.className =
          "rounded-md bg-accent px-2 py-1 text-xs font-semibold text-canvas shadow-lg disabled:cursor-not-allowed disabled:bg-panel-raised disabled:text-muted";
        button.addEventListener("click", () => {
          const selection = resolved();
          if (selection === undefined) return;
          onTransformSelection(selection);
          context.close();
        });
        return button;
      },
    }),
    [effective, highlightRange, onTransformSelection, resolveTransformSelection, search],
  );

  useEffect(() => {
    const editor = editorRef.current;
    if (editor !== undefined) {
      setMarkersIfAttached(editor, markersForSearch(effective, search));
      setSelectionIfAttached(editor, highlightRange);
    }
  }, [effective, highlightRange, search]);

  const file = { name: filename, contents: effective, cacheKey: `${filename}:${effective.length}` };
  return (
    <EditProvider createEditor={createEditor}>
      {original === undefined || original === effective ? (
        <File
          file={file}
          edit
          editorOptions={editorOptions}
          options={viewerOptions}
          disableWorkerPool
        />
      ) : (
        <MultiFileDiff
          oldFile={{ name: filename, contents: original }}
          newFile={file}
          edit
          editorOptions={editorOptions}
          options={{ ...viewerOptions, diffStyle: "unified", expandUnchanged: true }}
          disableWorkerPool
        />
      )}
    </EditProvider>
  );
}

const viewerOptions = {
  theme: "pierre-dark" as const,
  overflow: "wrap" as const,
  disableFileHeader: true,
  disableLineNumbers: false,
};

export function markersForSearch(text: string, search: string) {
  const needle = search.trim().toLocaleLowerCase();
  if (needle === "") return [];
  const markers = [];
  for (const [line, value] of text.split("\n").entries()) {
    const lower = value.toLocaleLowerCase();
    let offset = 0;
    while (offset <= lower.length) {
      const start = lower.indexOf(needle, offset);
      if (start === -1) break;
      markers.push({
        start: { line, character: start },
        end: { line, character: start + needle.length },
        severity: "info" as const,
        message: `Search match: ${search}`,
        source: "search",
      });
      offset = start + Math.max(needle.length, 1);
    }
  }
  return markers;
}

export function setMarkersIfAttached(
  editor: Pick<Editor<undefined>, "getFile" | "setMarkers">,
  markers: Parameters<Editor<undefined>["setMarkers"]>[0],
) {
  if (editor.getFile() === undefined) return;
  editor.setMarkers(markers);
}

export function setSelectionIfAttached(
  editor: Pick<Editor<undefined>, "setSelections">,
  range: TextRange | undefined,
) {
  if (range === undefined) return;
  editor.setSelections([{ ...range, direction: "forward" }]);
}
