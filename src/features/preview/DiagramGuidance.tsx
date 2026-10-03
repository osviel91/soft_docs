import { useEffect, useId, useRef, useState } from "react";

export type GuidanceView = "sequence" | "event-flow" | "topology" | "causal" | "catalog";

type Guide = { title: string; read: string; notation: string[]; interaction: string[] };

// Representation-specific language stays beside the views that expose it.
export const DIAGRAM_GUIDES: Record<GuidanceView, Guide> = {
  sequence: {
    title: "Sequence",
    read: "Read interactions from top to bottom; each numbered message is one ordered step between participants.",
    notation: ["Participant boxes and actor figures own dashed lifelines.", "Solid or dashed directional arrows show messages; filled, open, cross, and two-headed endings follow the authored Sequence style.", "Activation bars show work in progress. Folded-note bullets open authored notes; frames label loop, alternative, optional, parallel, critical, and break regions."],
    interaction: ["Select a rendered element to reveal its source.", "Drag the canvas to pan; scroll to zoom. Note bullets expand on activation."],
  },
  "event-flow": {
    title: "Event Flow",
    read: "Flow rows show message publication and consumption context. Derived row order and cycle tags describe topology ordering, not handler causality or execution.",
    notation: ["Service boxes publish toward event boxes; event boxes fan out toward consuming services.", "Channel chips name the publication channel. A dashed event outline and “no producer” label mean the event is declared but no producer is documented.", "A “cycle” tag marks a cycle in derived topology ordering; it is not a causal edge."],
    interaction: ["Select a node to reveal its source. Pan and zoom with the canvas controls."],
  },
  topology: {
    title: "Event Flow · Topology",
    read: "Connections summarize which services publish messages consumed by other services. A connection is topology, not evidence that one message causes another.",
    notation: ["Rounded service nodes are labeled with their producer/consumer role.", "Directed connections point from producer to consumer and label the number of connected events; a loop is a service connected to itself."],
    interaction: ["Select a service to reveal its source. Open Details for the events and channels behind a connection; pan and zoom the canvas."],
  },
  causal: {
    title: "Event Flow · Causal",
    read: "Edges project explicit authored causal facts: a message is handled by a handler, and a handler may cause another message. Topology publication/consumption and execution order do not create these edges.",
    notation: ["Labeled nodes are messages, handlers, effects, failures, or retries; the node kind is written on each node.", "Directed edges mean handled by, causes, has effect, failed, retried, retry initiates message, or retry targets handler. Dashed edges represent handler effects or recovery relations; red-accented nodes/edges represent failure and retry records."],
    interaction: ["Select a node to inspect its explicit upstream and downstream neighbors and source.", "Selection highlights the selected node and immediate causal neighbors; dimmed items are unrelated to this investigation selection, not changed knowledge."],
  },
  catalog: {
    title: "Event Flow · Catalog",
    read: "The catalog groups declared messages with their documented publications, subscriptions, metadata, and recovery facts. Missing entries remain undocumented, not disproven.",
    notation: ["Published by and Consumed by list authored publication and subscription occurrences.", "Failure and retry details appear only when documented; missing mechanisms or exhaustion are labeled unknown."],
    interaction: ["Select a message, service, channel, failure, or retry to reveal its source."],
  },
};

export default function DiagramGuidance({ view, comparison = false, diffDecorations = false }: { view: GuidanceView; comparison?: boolean; diffDecorations?: boolean }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => setOpen(false), [view, comparison]);
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: KeyboardEvent | MouseEvent) => {
      if (event instanceof KeyboardEvent && event.key === "Escape") setOpen(false);
      else if (event instanceof MouseEvent && !root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", dismiss);
    document.addEventListener("click", dismiss);
    return () => { document.removeEventListener("keydown", dismiss); document.removeEventListener("click", dismiss); };
  }, [open]);
  const guide = DIAGRAM_GUIDES[view];
  return <div className="diagram-guidance" ref={root}>
    <button type="button" className="icon-button diagram-guidance__trigger" title={`How to read ${guide.title}`} aria-label={`How to read ${guide.title}`} aria-expanded={open} aria-controls={panelId} onClick={() => setOpen((value) => !value)}>ⓘ</button>
    {open && <aside id={panelId} className="diagram-guidance__panel" aria-label={`${guide.title} guidance`}>
      <button type="button" className="diagram-guidance__close" aria-label="Close diagram guidance" onClick={() => setOpen(false)}>×</button>
      <h2>How to read {guide.title}</h2>
      <p>{guide.read}</p>
      {view !== "catalog" && <div className={`diagram-guidance__sample diagram-guidance__sample--${view}`} aria-label={`${guide.title} notation sample`}>
        {view === "sequence" && <><span className="diagram-guidance__lifeline" /><span className="diagram-guidance__message" /><span className="diagram-guidance__message diagram-guidance__message--dashed" /></>}
        {view === "event-flow" && <><span className="diagram-guidance__box">service</span><span className="diagram-guidance__message" /><span className="diagram-guidance__box">event</span></>}
        {view === "topology" && <><span className="diagram-guidance__box">producer</span><span className="diagram-guidance__message" /><span className="diagram-guidance__box">consumer</span></>}
        {view === "causal" && <><span className="diagram-guidance__box">message</span><span className="diagram-guidance__message diagram-guidance__message--dashed" /><span className="diagram-guidance__box">effect</span></>}
      </div>}
      <details className="diagram-guidance__more"><summary>Learn more</summary>
        {comparison && <p>Each viewer is a separate resource and context. A shared semantic selection highlights occurrences, not resource changes.</p>}
        {diffDecorations && <p>Added, removed, and modified decorations are resource diff states, not relationship types.</p>}
        <ul>{guide.notation.concat(guide.interaction).map((entry) => <li key={entry}>{entry}</li>)}</ul>
      </details>
    </aside>}
  </div>;
}
