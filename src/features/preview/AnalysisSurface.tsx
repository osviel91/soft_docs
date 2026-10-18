import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import type { AnalysisPreferenceTab } from "../../workspace/ui-preferences";

interface Props {
  message: ReactNode;
  relationships: ReactNode;
  trace: ReactNode;
}

type AnalysisTab = AnalysisPreferenceTab | "trace";
const MIN_HEIGHT = 110;
const MIN_PREVIEW_HEIGHT = 200;

export default function AnalysisSurface({ message, relationships, trace, minimized: preferredMinimized, height: preferredHeight, preferredTab, onLayoutPreferenceChange }: Props & {
  minimized?: boolean;
  height?: number;
  preferredTab?: AnalysisPreferenceTab;
  onLayoutPreferenceChange?: (patch: Partial<{ minimized: boolean; height: number; tab: AnalysisPreferenceTab }>) => void;
}) {
  const surfaceRef = useRef<HTMLElement | null>(null);
  const [localMinimized, setLocalMinimized] = useState(true);
  const [localHeight, setLocalHeight] = useState(250);
  const [localTab, setLocalTab] = useState<AnalysisPreferenceTab>("message");
  const [temporaryTab, setTemporaryTab] = useState<AnalysisTab | null>(null);
  const [traceOpenOverride, setTraceOpenOverride] = useState<boolean | null>(null);
  const [parentHeight, setParentHeight] = useState(0);
  const [resizing, setResizing] = useState(false);
  const hasMessage = message !== null;
  const hasRelationships = relationships !== null;
  const hasTrace = trace !== null;
  const minimizedPreference = preferredMinimized ?? localMinimized;
  const desiredHeight = preferredHeight ?? localHeight;
  const tabPreference = preferredTab ?? localTab;
  const minimized = traceOpenOverride ?? minimizedPreference;
  const height = Math.min(desiredHeight, parentHeight > 0 ? Math.max(MIN_HEIGHT, parentHeight - MIN_PREVIEW_HEIGHT) : desiredHeight);

  useEffect(() => {
    setTemporaryTab(hasTrace ? "trace" : null);
    setTraceOpenOverride(hasTrace ? false : null);
  }, [hasTrace]);

  useLayoutEffect(() => {
    const parent = surfaceRef.current?.parentElement;
    if (!parent) return;
    const measure = () => setParentHeight(parent.getBoundingClientRect().height);
    measure();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(parent);
    return () => observer.disconnect();
  }, []);

  const changeMinimized = (next: boolean) => {
    if (hasTrace) setTraceOpenOverride(next);
    if (next === minimizedPreference) return;
    if (preferredMinimized === undefined) setLocalMinimized(next);
    onLayoutPreferenceChange?.({ minimized: next });
  };
  const changeHeight = (next: number) => {
    if (preferredHeight === undefined) setLocalHeight(next);
    onLayoutPreferenceChange?.({ height: next });
  };
  const changeTab = (next: AnalysisTab) => {
    setTemporaryTab(next);
    changeMinimized(false);
    if (next === "trace") return;
    if (preferredTab === undefined) setLocalTab(next);
    onLayoutPreferenceChange?.({ tab: next });
  };

  const resize = (clientY: number) => {
    const parent = surfaceRef.current?.parentElement;
    if (!parent) return;
    const bounds = parent.getBoundingClientRect();
    const maximum = Math.max(MIN_HEIGHT, bounds.height - MIN_PREVIEW_HEIGHT);
    changeHeight(Math.min(maximum, Math.max(MIN_HEIGHT, bounds.bottom - clientY)));
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
    changeHeight(Math.min(maximum, Math.max(MIN_HEIGHT, desiredHeight + (event.key === "ArrowUp" ? 32 : -32))));
  };

  const tabs: Array<{ id: AnalysisTab; label: string }> = [
    ...(hasMessage ? [{ id: "message" as const, label: "Message" }] : []),
    ...(hasRelationships ? [{ id: "relationships" as const, label: "Relationships" }] : []),
    ...(hasTrace ? [{ id: "trace" as const, label: "Trace" }] : []),
  ];
  const requestedTab = temporaryTab ?? tabPreference;
  const selectedTab = tabs.some((tab) => tab.id === requestedTab) ? requestedTab : tabs[0]?.id ?? "message";

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
          onClick={() => changeTab(tab.id)}
          >{tab.label}</button>)}
        </div>
        <button
          type="button"
          className="button button--ghost button--small"
          aria-label={minimized ? "Restore analysis panels" : "Minimize analysis panels"}
          onClick={() => changeMinimized(!minimized)}
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
