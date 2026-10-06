export const CONCEPTUAL_SVG_STYLE = `
.conceptual__concept { color: var(--text, #202634); cursor: pointer; }
.conceptual__concept rect { fill: var(--bg-panel, var(--panel, var(--bg, #fff))); stroke: var(--border-strong, var(--border, #5b6472)); stroke-width: 1.5; }
.conceptual__concept--dim { opacity: .72; }
.conceptual__name { fill: var(--text, #202634); font: 600 16px var(--font-sans, system-ui, sans-serif); }
.conceptual__description { fill: var(--text-muted, var(--muted, #5b6472)); font: 13px var(--font-sans, system-ui, sans-serif); }
.conceptual__connection { color: var(--text-muted, var(--muted, #5b6472)); }
.conceptual__connection path { vector-effect: non-scaling-stroke; stroke-width: 2.25; }
.conceptual__connection--undirected path { stroke-dasharray: 5 3; }
.conceptual__edge-label rect { fill: var(--bg, var(--panel, #fff)); stroke: none; }
.conceptual__edge-label text { fill: currentColor; font: 500 12px var(--font-sans, system-ui, sans-serif); }
.conceptual__key-caption { fill: var(--text-muted, var(--muted, #5b6472)); font: 500 10px var(--font-sans, system-ui, sans-serif); }
.conceptual__concept:focus rect, .conceptual__concept.svg-node--active rect { stroke: var(--accent, #1f5fbf); stroke-width: 3; }
.conceptual__concept.svg-node--active rect { fill: var(--accent-soft, #e7effb); }
.conceptual__connection--related { color: var(--accent-strong, var(--accent, #1f5fbf)); }
.conceptual__connection--dim { opacity: .58; }
`;
