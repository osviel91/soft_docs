import type { SourceDiff } from "../../domain/diff/resource-diff";

export function SourceDiffView({ source, beforeContent, afterContent, mode = "unified", beforeLabel = "BASE", afterLabel = "PROPOSED" }: {
  source: SourceDiff;
  beforeContent: string;
  afterContent: string;
  mode?: "unified" | "side-by-side";
  beforeLabel?: string;
  afterLabel?: string;
}) {
  if (!source.changed) return <p>No textual changes.</p>;
  if (mode === "side-by-side" && !source.truncated) {
    const rows = alignLines(beforeContent.replace(/\r\n?/g, "\n").split("\n"), afterContent.replace(/\r\n?/g, "\n").split("\n"), source.hunks);
    return <div className="proposal-detail__side-by-side"><div><h4>{beforeLabel}</h4>{rows.map((row, index) => <div key={`old-${index}`} className={`proposal-review__line${row.changed ? " proposal-review__line--removed" : ""}`}><span>{row.oldNumber ?? ""}</span> {row.oldLine}</div>)}</div><div><h4>{afterLabel}</h4>{rows.map((row, index) => <div key={`new-${index}`} className={`proposal-review__line${row.changed ? " proposal-review__line--added" : ""}`}><span>{row.newNumber ?? ""}</span> {row.newLine}</div>)}</div></div>;
  }
  return <div className="proposal-detail__source-diff" data-testid="source-diff-view">
    {source.truncated ? <p role="status">Source diff truncated: showing {source.returnedHunks} of {source.totalHunks} hunks.</p> : null}
    {source.hunks.map((hunk, index) => <div key={`${hunk.oldStart}-${hunk.newStart}-${index}`}><div>@@ {hunk.oldStart} / {hunk.newStart} @@</div>{hunk.oldLines.map((line, lineIndex) => <div className="proposal-review__line proposal-review__line--removed" key={`old-${lineIndex}`}>- {line}</div>)}{hunk.newLines.map((line, lineIndex) => <div className="proposal-review__line proposal-review__line--added" key={`new-${lineIndex}`}>+ {line}</div>)}</div>)}
  </div>;
}

function alignLines(oldLines: string[], newLines: string[], hunks: SourceDiff["hunks"]): Array<{ oldLine: string; newLine: string; oldNumber: number | null; newNumber: number | null; changed: boolean }> {
  const rows: Array<{ oldLine: string; newLine: string; oldNumber: number | null; newNumber: number | null; changed: boolean }> = [];
  let oldIndex = 0;
  let newIndex = 0;
  for (const hunk of hunks) {
    const oldStart = Math.max(oldIndex, hunk.oldStart - 1);
    const newStart = Math.max(newIndex, hunk.newStart - 1);
    while (oldIndex < oldStart && newIndex < newStart) {
      rows.push({ oldLine: oldLines[oldIndex], newLine: newLines[newIndex], oldNumber: oldIndex + 1, newNumber: newIndex + 1, changed: false });
      oldIndex += 1;
      newIndex += 1;
    }
    while (oldIndex < oldStart) {
      rows.push({ oldLine: oldLines[oldIndex], newLine: "", oldNumber: oldIndex + 1, newNumber: null, changed: true });
      oldIndex += 1;
    }
    while (newIndex < newStart) {
      rows.push({ oldLine: "", newLine: newLines[newIndex], oldNumber: null, newNumber: newIndex + 1, changed: true });
      newIndex += 1;
    }
    for (let index = 0; index < Math.max(hunk.oldLines.length, hunk.newLines.length); index += 1) {
      const oldLine = hunk.oldLines[index];
      const newLine = hunk.newLines[index];
      rows.push({ oldLine: oldLine ?? "", newLine: newLine ?? "", oldNumber: oldLine === undefined ? null : oldIndex + 1, newNumber: newLine === undefined ? null : newIndex + 1, changed: true });
      if (oldLine !== undefined) oldIndex += 1;
      if (newLine !== undefined) newIndex += 1;
    }
  }
  while (oldIndex < oldLines.length && newIndex < newLines.length && oldLines[oldIndex] === newLines[newIndex]) {
    rows.push({ oldLine: oldLines[oldIndex], newLine: newLines[newIndex], oldNumber: oldIndex + 1, newNumber: newIndex + 1, changed: false });
    oldIndex += 1;
    newIndex += 1;
  }
  while (oldIndex < oldLines.length) {
    rows.push({ oldLine: oldLines[oldIndex], newLine: "", oldNumber: oldIndex + 1, newNumber: null, changed: true });
    oldIndex += 1;
  }
  while (newIndex < newLines.length) {
    rows.push({ oldLine: "", newLine: newLines[newIndex], oldNumber: null, newNumber: newIndex + 1, changed: true });
    newIndex += 1;
  }
  return rows;
}
