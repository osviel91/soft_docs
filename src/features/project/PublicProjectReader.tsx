import { useEffect, useMemo, useState } from "react";
import { ServerApiClient, type PublicSharedProject } from "../../workspace/server/api-client";
import MarkdownView from "../notes/MarkdownView";
import Preview from "../preview/Preview";
import EventFlowPreview, { type EventFlowView } from "../preview/EventFlowPreview";
import ConceptualPreview from "../preview/ConceptualPreview";
import { noteDisplayName } from "../../language/markdown/note-title";
import { diagramDisplayName } from "../../language/diagram-title";
import PresentationMode from "../presentation/PresentationMode";

const preferred = (resource: PublicSharedProject["resources"][number]) => /(^|\/)(overview|readme)(\.|$)/i.test(resource.path) || /^(overview|readme)$/i.test(resource.title);

export default function PublicProjectReader({ token }: { token: string }) {
  const client = useMemo(() => new ServerApiClient(), []);
  const [project, setProject] = useState<PublicSharedProject | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "unavailable" | "error">("loading");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [eventView, setEventView] = useState<EventFlowView>("flow");
  const [navigationOpen, setNavigationOpen] = useState(false);
  const [presenting, setPresenting] = useState(new URLSearchParams(window.location.search).get("presentation") === "1");

  const load = async () => {
    setState("loading");
    try { const result = await client.readPublicSharedProject(token); setProject(result); setSelectedId((current) => { const requested = new URLSearchParams(window.location.search).get("resource"); return result.resources.some((resource) => resource.id === requested) ? requested : result.resources.some((resource) => resource.id === current) ? current : [...result.resources].sort((a, b) => Number(preferred(b)) - Number(preferred(a)) || a.path.localeCompare(b.path))[0]?.id ?? null; }); setState("ready"); }
    catch (error) { setProject(null); setState(error instanceof Error && error.message === "unavailable" ? "unavailable" : "error"); }
  };
  useEffect(() => { void load(); }, [client, token]);
  useEffect(() => {
    const onPopState = () => setPresenting(new URLSearchParams(window.location.search).get("presentation") === "1");
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);
  const selected = project?.resources.find((resource) => resource.id === selectedId) ?? null;
  const changePresentationView = (view: EventFlowView) => { setEventView(view); const url = new URL(window.location.href); url.searchParams.set("view", view); window.history.replaceState(null, "", url); };
  const openResource = (target: string) => {
    if (!project || !selected) return;
    const path = target.startsWith("/") ? target.slice(1) : new URL(target, `https://public.invalid/${selected.path}`).pathname.slice(1);
    const match = project.resources.find((resource) => resource.path === path);
    if (match) setSelectedId(match.id);
  };
  const openWikiLink = (target: string) => {
    const match = project?.resources.find((resource) => resource.title === target || noteDisplayName(resource.path, resource.content) === target || diagramDisplayName(resource.path, resource.content) === target);
    if (match) setSelectedId(match.id);
  };
  const isMarkdown = selected?.type === "markdown-document";
  const isEventFlow = selected?.type === "event-flow";
  const label = selected ? isMarkdown ? noteDisplayName(selected.path, selected.content) : diagramDisplayName(selected.path, selected.content) : "";

  if (state === "loading") return <main className="public-reader-state" role="status">Loading shared documentation…</main>;
  if (state === "unavailable") return <main className="public-reader-state" role="status"><h1>This shared project is no longer available.</h1></main>;
  if (state === "error") return <main className="public-reader-state"><h1>Shared documentation could not be loaded.</h1><p>Check your connection and try again.</p><button type="button" onClick={() => void load()}>Retry</button></main>;
  if (!project) return null;

  if (presenting) { const requestedView = new URLSearchParams(window.location.search).get("view"); const initialView = requestedView === "catalog" || requestedView === "topology" || requestedView === "causal" ? requestedView : eventView; return <PresentationMode projectName={project.project.name} resources={project.resources} initialId={selectedId ?? project.resources[0]?.id ?? ""} initialView={initialView} onRepresentationChange={changePresentationView} onSelect={(id) => { setSelectedId(id); const url = new URL(window.location.href); url.searchParams.set("resource", id); window.history.replaceState(null, "", url); }} onExit={() => { const url = new URL(window.location.href); url.searchParams.delete("presentation"); window.history.replaceState(null, "", url); setPresenting(false); }} />; }

  return <main className="public-reader" data-testid="public-reader">
    <header className="public-reader__header"><strong>Software Docs</strong><h1>{project.project.name}</h1><span>Read only</span><button type="button" onClick={() => { const url = new URL(window.location.href); url.searchParams.set("presentation", "1"); if (selectedId) url.searchParams.set("resource", selectedId); window.history.pushState(null, "", url); setPresenting(true); }}>Present</button><button type="button" className="public-reader__menu-toggle" aria-expanded={navigationOpen} aria-controls="public-reader-navigation" onClick={() => setNavigationOpen((open) => !open)}>Documentation</button></header>
    <div className="public-reader__body">
      <nav id="public-reader-navigation" className={`public-reader__nav${navigationOpen ? " public-reader__nav--open" : ""}`} aria-label="Shared documentation">
        <h2>Architecture</h2>
        {project.resources.length ? <ul>{[...project.resources].sort((a, b) => a.path.localeCompare(b.path)).map((resource) => <li key={resource.id}><button type="button" aria-current={resource.id === selectedId ? "page" : undefined} onClick={() => { setSelectedId(resource.id); setNavigationOpen(false); }}>{resource.title || resource.path}</button></li>)}</ul> : <p>No shared documentation is available yet.</p>}
      </nav>
      <section className="public-reader__content" aria-label={selected ? `Reading ${label}` : "Shared project content"}>
        {selected ? <>
          <div className="public-reader__resource-heading"><div><p>{selected.path}</p><h2>{label}</h2></div></div>
           {isMarkdown ? <MarkdownView markdown={selected.content} resolveWikiLink={(target) => project.resources.some((resource) => resource.title === target || noteDisplayName(resource.path, resource.content) === target || diagramDisplayName(resource.path, resource.content) === target) ? "#shared-resource" : null} resolveResourceLink={(href) => { try { const target = new URL(href, `https://public.invalid/${selected.path}`).pathname.slice(1); return project.resources.some((resource) => resource.path === target) ? "#shared-resource" : null; } catch { return null; } }} onOpenDiagramLink={openWikiLink} onOpenResourceLink={openResource} /> : isEventFlow ? <EventFlowPreview source={selected.content} view={eventView} onViewChange={setEventView} /> : selected.type === "conceptual" ? <ConceptualPreview source={selected.content} /> : <Preview source={selected.content} />}
        </> : <div className="public-reader__empty"><h2>No shared documentation is available yet.</h2><p>This project does not currently have active shared resources.</p></div>}
      </section>
    </div>
    <footer className="public-reader__footer">Shared documentation · Read only</footer>
  </main>;
}
