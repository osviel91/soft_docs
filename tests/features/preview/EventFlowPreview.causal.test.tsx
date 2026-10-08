import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { nodeIdOf } from "../../../src/domain/diagram/node-id";
import { eventsOf } from "../../../src/domain/eventflow/ast";
import { projectEventFlowToCausalView } from "../../../src/domain/eventflow/causal-projection";
import { analyzeEventFlow } from "../../../src/language/eventflow/parser";
import EventFlowPreview from "../../../src/features/preview/EventFlowPreview";

vi.mock("../../../src/renderer/causal/CausalFlowView", () => ({
  default: ({ view, selectedNodeId }: { view: { messages: unknown[] }; selectedNodeId: string | null }) => <div data-testid="causal-flow-view" data-selected-node-id={selectedNodeId ?? ""}>{view.messages.length} causal messages</div>,
}));

afterEach(cleanup);

describe("EventFlowPreview causal integration", () => {
  it("renders the production React Flow causal surface for explicit causality", () => {
    render(<EventFlowPreview source={["event A", "event B", "handler H", "A handled by H", "H causes B", "effect save on H: save state"].join("\n")} view="causal" />);
    expect(screen.getByTestId("causal-flow-view")).toHaveTextContent("2 causal messages");
  });

  it("maps a selected Event Flow source node to its causal graph node", () => {
    const source = ["event A", "event B", "handler H", "A handled by H", "H causes B"].join("\n");
    const flow = analyzeEventFlow(source).flow;
    const sourceNodeId = nodeIdOf("event", eventsOf(flow).find(event => event.name === "A")!.range);
    const expectedCausalId = projectEventFlowToCausalView(flow).messages.find(message => message.sourceNodeIds.includes(sourceNodeId))!.id;

    render(<EventFlowPreview source={source} view="causal" activeNodeId={sourceNodeId} />);

    expect(screen.getByTestId("causal-flow-view")).toHaveAttribute("data-selected-node-id", expectedCausalId);
  });

  it("preserves the truthful empty state when no causal facts exist", () => {
    render(<EventFlowPreview source="event A" view="causal" />);
    expect(screen.getByTestId("event-causal-empty")).toHaveTextContent("explicit causal relationships");
  });
});
