import { describe, expect, it } from "vitest";
import { analyzeEventFlow } from "../../src/language/eventflow/parser";
import { projectEventFlowToCausalView } from "../../src/domain/eventflow/causal-projection";
import { renderCausalFlowSvg } from "../../src/renderer/causal/causal-flow-svg";
import { causalElkGraph, causalFlowElements, positionedCausalFlow } from "../../src/renderer/causal/causal-flow-adapter";
import ELK from "elkjs/lib/elk.bundled.js";

describe("causal React Flow export", () => {
  it("serializes the positioned graph without the legacy renderer", async () => {
    const view = projectEventFlowToCausalView(analyzeEventFlow("event A\nhandler H\nA handled by H\neffect save on H: save state").flow);
    const graph = positionedCausalFlow(view, await new ELK().layout(causalElkGraph(view)));
    const document = renderCausalFlowSvg(graph, view);
    expect(document.svg).toContain("<svg");
    expect(document.svg).toContain("save state");
    expect(document.svg).toContain("owned by H");
    expect(document.width).toBeGreaterThan(graph.width);
    expect(document.height).toBeGreaterThan(graph.height);
  });

  it("exports the same complete lexical label lines as the interactive graph", async () => {
    const label = "BillerViabilityEventRaisedHandler";
    const view = projectEventFlowToCausalView(analyzeEventFlow([
      "event InputEvent",
      `event ${label}`,
      "handler Handler",
      "InputEvent handled by Handler",
      `Handler causes ${label}`,
    ].join("\n")).flow);
    const node = causalFlowElements(view).nodes.find((item) => item.data.label === label)!;
    const labelLines = node.data.labelLines ?? [];
    const graph = positionedCausalFlow(view, await new ELK().layout(causalElkGraph(view)));
    const document = renderCausalFlowSvg(graph, view);

    expect(labelLines.join("")).toBe(label);
    expect(document.svg).toContain(`<title>${label}</title>`);
    for (const line of labelLines) expect(document.svg).toContain(`>${line}</tspan>`);
    expect(document.svg).not.toContain("BillerViabilityEventRaisedHa</tspan>");
  });
});
