import { Editor, type EditorOptions } from "@pierre/diffs/edit";
import { EditProvider, File, MultiFileDiff } from "@pierre/diffs/react";
import { useCallback, useEffect, useMemo, useRef } from "react";

export function ContextDiff({
  original,
  effective,
  filename,
  search,
  onTransformSelection,
}: {
  original?: string;
  effective: string;
  filename: string;
  search: string;
  onTransformSelection: (text: string) => void;
}) {
  const editorRef = useRef<Editor<undefined>>(undefined);
  const createEditor = useCallback((options: EditorOptions<undefined>) => new Editor(options), []);
  const editorOptions = useMemo<EditorOptions<undefined>>(
    () => ({
      enabledSelectionAction: true,
      onAttach(editor) {
        editorRef.current = editor as Editor<undefined>;
      },
      renderSelectionAction(context) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = "Transform";
        button.className =
          "rounded-md bg-accent px-2 py-1 text-xs font-semibold text-canvas shadow-lg";
        button.addEventListener("click", () => {
          onTransformSelection(context.getSelectionText());
          context.close();
        });
        return button;
      },
    }),
    [onTransformSelection],
  );

  useEffect(() => {
    editorRef.current?.setMarkers(markersForSearch(effective, search));
  }, [effective, search]);

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
