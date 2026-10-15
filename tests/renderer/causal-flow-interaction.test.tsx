import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import ELK from "elkjs/lib/elk.bundled.js";
import { analyzeEventFlow } from "../../src/language/eventflow/parser";
import { projectEventFlowToCausalView } from "../../src/domain/eventflow/causal-projection";
import CausalFlowView from "../../src/renderer/causal/CausalFlowView";
import type { CausalLayoutWorker } from "../../src/renderer/causal/causal-elk-layout";
import type { CausalElkRequest, CausalElkResponse } from "../../src/renderer/causal/causal-flow-adapter";

vi.mock("@xyflow/react", () => ({
  BaseEdge: () => null,
  Background: () => null,
  Controls: () => null,
  Handle: () => null,
  MiniMap: () => null,
  Position: { Left: "left", Right: "right" },
  ReactFlowProvider: ({ children }: { children: ReactNode }) => children,
  ReactFlow: (props: {
    nodes: Array<{ id: string; className?: string; data: { sourceNodeIds: string[] } }>;
    edges: Array<{ id: string; className?: string; ariaLabel?: string }>;
    onNodeClick: (event: unknown, node: { id: string; data: { sourceNodeIds: string[] } }) => void;
    onEdgeClick: (event: unknown, edge: { id: string }) => void;
  }) => <div>
    {props.nodes.map((node) => <button key={node.id} type="button" data-id={node.id} className={node.className} onClick={(event) => props.onNodeClick(event, node)}>{node.id}</button>)}
    {props.edges.map((edge) => <button key={edge.id} type="button" data-id={edge.id} aria-label={edge.ariaLabel} className={`react-flow__edge ${edge.className ?? ""}`} onClick={(event) => props.onEdgeClick(event, edge)}>{edge.id}</button>)}
  </div>,
}));

afterEach(cleanup);

function elkWorkerFactory() {
  return () => {
    const worker: CausalLayoutWorker = {
      onmessage: null,
      onerror: null,
      terminate() {},
      postMessage(message: CausalElkRequest) {
        void new ELK().layout(message.graph).then((graph) => worker.onmessage?.({ data: { id: message.id, graph } satisfies CausalElkResponse } as MessageEvent<CausalElkResponse>));
      },
    };
    return worker;
  };
}

function disconnectedView() {
  return projectEventFlowToCausalView(analyzeEventFlow([
    "event First", "event Second", "handler FirstHandler", "handler SecondHandler",
    "First handled by FirstHandler", "Second handled by SecondHandler", "effect persist-first on FirstHandler: persist first",
  ].join("\n")).flow);
}

describe("causal graph interaction", () => {
  it("selects a relation, shows its type and source line, and reveals the source", async () => {
    const view = disconnectedView();
    const onSourceSelect = vi.fn();
    const { container } = render(<CausalFlowView view={view} workerFactory={elkWorkerFactory()} onSourceSelect={onSourceSelect} />);
    await waitFor(() => expect(container.querySelectorAll(".react-flow__edge").length).toBe(view.edges.length));
    const selected = view.edges[0]!;
    const edgeElement = [...container.querySelectorAll<HTMLButtonElement>(".react-flow__edge")].find((element) => element.dataset.id === selected.id)!;
    fireEvent.click(edgeElement);

    const details = await screen.findByTestId("causal-edge-details");
    expect(details).toHaveTextContent(selected.type.replaceAll("_", " "));
    expect(details).toHaveTextContent("Source line 5");
    expect(edgeElement).toHaveClass("is-selected");
    expect(container.querySelector('[data-id="handler:FirstHandler"]')).not.toHaveClass("is-dimmed");
    expect(container.querySelector('[data-id="message:Second"]')).toHaveClass("is-dimmed");
    fireEvent.click(screen.getByRole("button", { name: "Source line 5" }));
    expect(onSourceSelect).toHaveBeenCalledWith(selected.sourceNodeIds[0]);
  });

  it("shows and reveals every source line for one selected causal edge", async () => {
    const view = projectEventFlowToCausalView(analyzeEventFlow([
      "event Input",
      "handler H",
      "Input handled by H",
      "Input handled by H",
    ].join("\n")).flow);
    const onSourceSelect = vi.fn();
    const { container } = render(<CausalFlowView view={view} workerFactory={elkWorkerFactory()} onSourceSelect={onSourceSelect} />);
    await waitFor(() => expect(container.querySelectorAll(".react-flow__edge")).toHaveLength(1));
    fireEvent.click(container.querySelector<HTMLButtonElement>(".react-flow__edge")!);

    const details = await screen.findByTestId("causal-edge-details");
    expect(within(details).getByRole("button", { name: "Source line 3" })).toBeInTheDocument();
    expect(within(details).getByRole("button", { name: "Source line 4" })).toBeInTheDocument();
    fireEvent.click(within(details).getByRole("button", { name: "Source line 3" }));
    fireEvent.click(within(details).getByRole("button", { name: "Source line 4" }));
    expect(onSourceSelect.mock.calls).toEqual([
      ["handler-input@2:0"],
      ["handler-input@3:0"],
    ]);
  });

  it("highlights the full directed reachable component and dims unrelated components", async () => {
    const view = disconnectedView();
    const { container } = render(<CausalFlowView view={view} selectedNodeId="message:First" workerFactory={elkWorkerFactory()} />);
    const firstNode = await screen.findByRole("button", { name: "message:First" });
    fireEvent.click(firstNode);
    await waitFor(() => expect(container.querySelector('[data-id="message:Second"]')).toHaveClass("is-dimmed"));

    expect(container.querySelector('[data-id="handler:FirstHandler"]')).not.toHaveClass("is-dimmed");
    expect(container.querySelector(`[data-id="${view.edges[0]!.id}"]`)).not.toHaveClass("is-dimmed");
    expect(container.querySelector('[data-id="effect:persist-first"]')).not.toHaveClass("is-dimmed");
    expect(container.querySelector(`[data-id="${view.edges.at(-1)!.id}"]`)).not.toHaveClass("is-dimmed");
  });
});
