import { describe, expect, it } from "vitest";
import { analyzeEventFlow } from "../../src/language/eventflow/parser";
import { projectEventFlowToCausalView } from "../../src/domain/eventflow/causal-projection";
import { renderCausalFlowSvg } from "../../src/renderer/causal/causal-flow-svg";
import { CAUSAL_PORT_SIZE, causalElkGraph, causalFlowElements, positionedCausalFlow } from "../../src/renderer/causal/causal-flow-adapter";
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

  it("renders every linked route section and marks only the terminal target", async () => {
    const view = projectEventFlowToCausalView(analyzeEventFlow([
      "event Input {", "  kind: command", "}", "handler Handler", "Input handled by Handler",
    ].join("\n")).flow);
    const graph = positionedCausalFlow(view, await new ELK().layout(causalElkGraph(view)));
    const edge = graph.edges[0]!;
    const sourceNode = graph.nodes.find((node) => node.id === edge.source)!;
    const targetNode = graph.nodes.find((node) => node.id === edge.target)!;
    const sourcePort = sourceNode.data.ports!.find((port) => port.id === edge.sourceHandle)!;
    const targetPort = targetNode.data.ports!.find((port) => port.id === edge.targetHandle)!;
    const source = {
      x: sourceNode.position.x + sourceNode.width! + CAUSAL_PORT_SIZE,
      y: sourceNode.position.y + sourcePort.top!,
    };
    const target = {
      x: targetNode.position.x - CAUSAL_PORT_SIZE,
      y: targetNode.position.y + targetPort.top!,
    };
    expect(target.x).toBeGreaterThan(source.x);
    const middleX = (source.x + target.x) / 2;
    const bendY = source.y + (target.y === source.y + 24 ? 48 : 24);
    const sourceSectionPoints = [source, { x: middleX, y: source.y }, { x: middleX, y: bendY }];
    const targetSectionPoints = [{ x: middleX, y: bendY }, { x: middleX, y: target.y }, target];
    const routes = [
      { id: "source-section", points: sourceSectionPoints, endsAtTarget: false },
      { id: "target-section", points: targetSectionPoints, endsAtTarget: true },
    ];
    const sectionLength = (points: Array<{ x: number; y: number }>) => points.slice(1).reduce(
      (length, point, index) => length + Math.hypot(point.x - points[index]!.x, point.y - points[index]!.y),
      0,
    );
    expect(routes.every((route) => sectionLength(route.points) > 0)).toBe(true);
    for (const route of routes) {
      for (let index = 1; index < route.points.length; index += 1) {
        expect(Math.hypot(route.points[index]!.x - route.points[index - 1]!.x, route.points[index]!.y - route.points[index - 1]!.y)).toBeGreaterThan(0);
      }
    }
    expect(sourceSectionPoints.at(-1)).toEqual(targetSectionPoints[0]);
    expect(sourceSectionPoints[0]).toEqual(source);
    expect(targetSectionPoints.at(-1)).toEqual(target);
    const positioned = {
      ...graph,
      edges: graph.edges.map((item) => item.id === edge.id
        ? { ...item, data: { ...item.data!, points: routes[0]!.points, routes } }
        : item),
    };
    const document = renderCausalFlowSvg(positioned, view);
    const paths = [...document.svg.matchAll(/<path data-causal-edge=.*?<\/path>/g)].map(([path]) => path!);
    const firstPath = paths[0]!;
    const targetPath = paths[1]!;
    const coordinates = (point: { x: number; y: number }) => `${point.x + 28} ${point.y + 56}`;

    expect(paths).toHaveLength(2);
    expect(firstPath).toContain(`d="M${coordinates(source)} L${coordinates(sourceSectionPoints[1]!)} L${coordinates(sourceSectionPoints[2]!)}"`);
    expect(firstPath).not.toContain("marker-end=");
    expect(targetPath).toContain(`d="M${coordinates(targetSectionPoints[0]!)} L${coordinates(targetSectionPoints[1]!)} L${coordinates(target)}"`);
    expect(targetPath).toContain("marker-end=\"url(#causal-arrow)\"");
    expect(paths.filter((path) => path.includes("marker-end="))).toHaveLength(1);
    expect(targetPath).toContain('MESSAGE HANDLED BY HANDLER: Input to Handler');
    expect(document.svg).toContain("MESSAGE · COMMAND");
  });

  it("exposes long labels accessibly and distinguishes fallback routes", async () => {
    const label = "A".repeat(300);
    const view = projectEventFlowToCausalView(analyzeEventFlow([
      `event ${label}`, "handler Handler", `${label} handled by Handler`,
    ].join("\n")).flow);
    const graph = positionedCausalFlow(view, await new ELK().layout(causalElkGraph(view)));
    const fallbackGraph = {
      ...graph,
      edges: graph.edges.map((edge) => ({
        ...edge,
        data: {
          ...edge.data!,
          routes: edge.data!.routes.map((route) => ({ ...route, fallback: true })),
        },
      })),
    };
    const document = renderCausalFlowSvg(fallbackGraph, view);
    const path = document.svg.match(/<path data-causal-edge=.*?<\/path>/)?.[0] ?? "";

    expect(document.svg).toContain(`aria-label="${label}"`);
    expect(document.svg).toContain(`<title>${label}</title>`);
    expect(path).toContain('stroke="#7c3aed"');
    expect(path).toContain('stroke-dasharray="3 3"');
    expect(path).toContain("(fallback route)");
  });
});
