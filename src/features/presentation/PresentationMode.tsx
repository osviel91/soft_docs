import { useEffect, useMemo, useState } from "react";
import MarkdownView from "../notes/MarkdownView";
import Preview from "../preview/Preview";
import EventFlowPreview, { type EventFlowView } from "../preview/EventFlowPreview";
import ConceptualPreview from "../preview/ConceptualPreview";
import { noteDisplayName } from "../../language/markdown/note-title";
import { diagramDisplayName } from "../../language/diagram-title";

export interface PresentationResource {
  id: string;
  path: string;
  title: string;
  type: string;
  content: string;
}

const preferred = (resource: PresentationResource) => /(^|\/)(overview|readme)(\.|$)/i.test(resource.path) || /^(overview|readme)$/i.test(resource.title);
export const orderedPresentationResources = <T extends PresentationResource>(resources: T[]) =>
  [...resources].sort((a, b) => Number(preferred(b)) - Number(preferred(a)) || a.path.localeCompare(b.path));

export default function PresentationMode({ projectName, resources, initialId, initialView = "flow", onExit, onSelect, onRepresentationChange }: {
  projectName: string;
  resources: PresentationResource[];
  initialId: string;
  initialView?: EventFlowView;
  onExit: () => void;
  onSelect?: (id: string) => void;
  onRepresentationChange?: (view: EventFlowView) => void;
}) {
  const ordered = useMemo(() => orderedPresentationResources(resources), [resources]);
  const [id, setId] = useState(initialId);
  const [navigatorOpen, setNavigatorOpen] = useState(false);
  const [eventView, setEventView] = useState<EventFlowView>(initialView);
  const selected = ordered.find((resource) => resource.id === id) ?? ordered[0];
  const index = selected ? ordered.indexOf(selected) : -1;
  const move = (next: number) => {
    const resource = ordered[next];
    if (!resource) return;
    setId(resource.id);
    onSelect?.(resource.id);
  };

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.target instanceof HTMLElement && (event.target.isContentEditable || /^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(event.target.tagName))) return;
      if (event.key === "Escape") { event.preventDefault(); onExit(); }
      if (event.key === "ArrowRight" || event.key === "PageDown") { event.preventDefault(); move(index + 1); }
      if (event.key === "ArrowLeft" || event.key === "PageUp") { event.preventDefault(); move(index - 1); }
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [index, ordered, onExit]);

  if (!selected) return <main className="presentation"><header><strong>{projectName}</strong><button onClick={onExit}>Exit presentation</button></header><p>No presentable architecture is available.</p></main>;
  const markdown = selected.type === "markdown-document" || selected.path.endsWith(".md");
  const eventFlow = selected.type === "event-flow" || /\.(flow|eventflow)$/i.test(selected.path);
  const conceptual = selected.type === "conceptual";
  const database = selected.type === "database";
  const title = markdown ? noteDisplayName(selected.path, selected.content) : diagramDisplayName(selected.path, selected.content);
  return <main className="presentation" aria-label="Architecture presentation" data-testid="presentation-mode">
    <header className="presentation__header"><div><strong>{projectName}</strong><span>{title}</span></div><button type="button" onClick={onExit}>Exit presentation <kbd>Esc</kbd></button></header>
    <section className={`presentation__stage${markdown ? " presentation__stage--markdown" : ""}`} aria-label={`${title}, item ${index + 1} of ${ordered.length}`}>
       {markdown ? <MarkdownView markdown={selected.content} /> : eventFlow ? <EventFlowPreview source={selected.content} view={eventView} onViewChange={(view) => { setEventView(view); onRepresentationChange?.(view); }} /> : conceptual ? <ConceptualPreview source={selected.content} /> : database ? <p role="status">Database source is not renderable in Presentation yet.</p> : <Preview source={selected.content} />}
    </section>
    <footer className="presentation__controls">
      <button type="button" aria-label="Previous presentation item" onClick={() => move(index - 1)} disabled={index <= 0}>‹ Previous</button>
      <span aria-live="polite">{index + 1} / {ordered.length}: {title}</span>
      <button type="button" aria-label="Next presentation item" onClick={() => move(index + 1)} disabled={index >= ordered.length - 1}>Next ›</button>
      <button type="button" aria-expanded={navigatorOpen} aria-controls="presentation-navigator" onClick={() => setNavigatorOpen((open) => !open)}>Architecture</button>
    </footer>
     {navigatorOpen && <nav id="presentation-navigator" className="presentation__navigator" aria-label="Presentation resources"><div className="presentation__navigator-header"><button type="button" className="presentation__navigator-close" aria-label="Close navigator" onClick={() => setNavigatorOpen(false)}>×</button></div>{ordered.map((resource, itemIndex) => <button type="button" key={resource.id} aria-current={resource.id === selected.id ? "page" : undefined} onClick={() => { move(itemIndex); setNavigatorOpen(false); }}>{resource.title || resource.path}</button>)}</nav>}
  </main>;
}
