import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";

interface Props {
  message: ReactNode;
  relationships: ReactNode;
  trace: ReactNode;
}

type AnalysisTab = "message" | "relationships" | "trace";
const MIN_HEIGHT = 110;
const MIN_PREVIEW_HEIGHT = 200;

export default function AnalysisSurface({ message, relationships, trace }: Props) {
  const surfaceRef = useRef<HTMLElement | null>(null);
  const [activeTab, setActiveTab] = useState<AnalysisTab>("message");
  const [minimized, setMinimized] = useState(false);
  const [height, setHeight] = useState(250);
  const [resizing, setResizing] = useState(false);
  const hasMessage = message !== null;
  const hasRelationships = relationships !== null;
  const hasTrace = trace !== null;

  useEffect(() => {
    if (hasTrace) setActiveTab("trace");
    else setActiveTab((current) => current === "trace" ? hasMessage ? "message" : "relationships" : current);
  }, [hasMessage, hasTrace]);

  const resize = (clientY: number) => {
    const parent = surfaceRef.current?.parentElement;
    if (!parent) return;
    const bounds = parent.getBoundingClientRect();
    const maximum = Math.max(MIN_HEIGHT, bounds.height - MIN_PREVIEW_HEIGHT);
    setHeight(Math.min(maximum, Math.max(MIN_HEIGHT, bounds.bottom - clientY)));
  };
  const endResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    setResizing(false);
  };
  const resizeWithKeyboard = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    const parent = surfaceRef.current?.parentElement;
    const maximum = parent ? Math.max(MIN_HEIGHT, parent.getBoundingClientRect().height - MIN_PREVIEW_HEIGHT) : height;
    setHeight((current) => Math.min(maximum, Math.max(MIN_HEIGHT, current + (event.key === "ArrowUp" ? 32 : -32))));
  };

  const tabs: Array<{ id: AnalysisTab; label: string }> = [
    ...(hasMessage ? [{ id: "message" as const, label: "Message" }] : []),
    ...(hasRelationships ? [{ id: "relationships" as const, label: "Relationships" }] : []),
    ...(hasTrace ? [{ id: "trace" as const, label: "Trace" }] : []),
  ];
  const selectedTab = tabs.some((tab) => tab.id === activeTab) ? activeTab : tabs[0]?.id ?? "message";

  return (
    <section
      ref={surfaceRef}
      className={`analysis-surface${minimized ? " analysis-surface--minimized" : ""}`}
      style={{ flexBasis: minimized ? 42 : height }}
      aria-label="Analysis panels"
      data-testid="analysis-surface"
    >
      {!minimized ? <div
        className="analysis-surface__splitter"
        role="separator"
        tabIndex={0}
        aria-label="Resize analysis panels"
        aria-orientation="horizontal"
        onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); setResizing(true); resize(event.clientY); }}
        onPointerMove={(event) => { if (resizing) resize(event.clientY); }}
        onPointerUp={endResize}
        onPointerCancel={endResize}
        onKeyDown={resizeWithKeyboard}
      /> : null}
      <div className="analysis-surface__toolbar">
        <div className="analysis-surface__tabs" role="tablist" aria-label="Analysis views">
          {tabs.map((tab) => <button
            key={tab.id}
            id={`analysis-tab-${tab.id}`}
            type="button"
            role="tab"
            aria-selected={selectedTab === tab.id}
            aria-controls={`analysis-panel-${tab.id}`}
            onClick={() => { setActiveTab(tab.id); setMinimized(false); }}
          >{tab.label}</button>)}
        </div>
        <button
          type="button"
          className="button button--ghost button--small"
          aria-label={minimized ? "Restore analysis panels" : "Minimize analysis panels"}
          onClick={() => setMinimized((current) => !current)}
        >{minimized ? "Restore" : "Minimize"}</button>
      </div>
      <div className="analysis-surface__content" hidden={minimized}>
        {hasMessage ? <div id="analysis-panel-message" role="tabpanel" aria-labelledby="analysis-tab-message" hidden={selectedTab !== "message"}>{message}</div> : null}
        {hasRelationships ? <div id="analysis-panel-relationships" role="tabpanel" aria-labelledby="analysis-tab-relationships" hidden={selectedTab !== "relationships"}>{relationships}</div> : null}
        {hasTrace ? <div id="analysis-panel-trace" role="tabpanel" aria-labelledby="analysis-tab-trace" hidden={selectedTab !== "trace"}>{trace}</div> : null}
      </div>
    </section>
  );
}
