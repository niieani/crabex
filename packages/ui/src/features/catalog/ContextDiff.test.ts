import { describe, expect, it, vi } from "vite-plus/test";

import { markersForSearch, setMarkersIfAttached } from "./ContextDiff.tsx";

describe("markersForSearch", () => {
  it("returns zero-based ranges for every case-insensitive occurrence", () => {
    expect(markersForSearch("Alpha alpha\nnot here\nALPHA", "alpha")).toMatchObject([
      { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
      { start: { line: 0, character: 6 }, end: { line: 0, character: 11 } },
      { start: { line: 2, character: 0 }, end: { line: 2, character: 5 } },
    ]);
  });

  it("does not create markers for an empty query", () => {
    expect(markersForSearch("content", "  ")).toEqual([]);
  });
});

describe("setMarkersIfAttached", () => {
  it("does not update a detached Pierre editor", () => {
    const setMarkers = vi.fn();

    setMarkersIfAttached({ getFile: () => undefined, setMarkers }, []);

    expect(setMarkers).not.toHaveBeenCalled();
  });
});
