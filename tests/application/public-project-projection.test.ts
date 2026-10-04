import { describe, expect, it } from "vitest";
import { buildPublicProjectProjection, type PublicProjectSource } from "../../src/application/public-project-projection";
import { projectEventFlowToCausalView } from "../../src/domain/eventflow/causal-projection";
import { projectEventFlowToFlowView } from "../../src/domain/eventflow/flow-projection";
import { projectEventFlowToTopology } from "../../src/domain/eventflow/topology-projection";
import { analyzeEventFlow } from "../../src/language/eventflow/parser";
import { analyze } from "../../src/language/analyze";

const projectId = "project-public";
const sequenceId = "diagram-order";
const flowId = "flow-order";
const sequence = `title Checkout
participant Buyer
participant CheckoutService
participant OrderDB
Buyer -> CheckoutService: place order
semantic command dispatch PlaceOrder messageRef msg-place-order
alt valid order
  CheckoutService -> OrderDB: save order
else invalid order
  CheckoutService -> Buyer: reject
end
note over Buyer,CheckoutService: Order boundary
`;
const flow = `title Checkout events
event OrderPlaced messageRef msg-order-placed
event OrderDelivered
event DeclaredOnly
producer CheckoutService
consumer ShippingService
channel orders topic
CheckoutService publishes OrderPlaced to orders
ShippingService consumes OrderPlaced from orders
handler PlaceOrderHandler in CheckoutService
OrderPlaced handled by PlaceOrderHandler
effect persist-order on PlaceOrderHandler kind state: persist order
PlaceOrderHandler causes OrderDelivered
`;

function source(id: string, path: string, type: PublicProjectSource["type"], content: string): PublicProjectSource {
  return { id, path, type, revision: 1, content };
}

describe("bounded public project projection", () => {
  it("builds hierarchy, canonical catalog, sequence, event-flow, topology and explicit causal facts from only its sources", () => {
    const result = buildPublicProjectProjection(projectId, [
      source(sequenceId, "architecture/checkout/order.seq", "sequence-diagram", sequence),
      source(flowId, "architecture/checkout/events.eventseq", "event-flow", flow),
      source("doc-order", "architecture/checkout/README.md", "markdown-document", "# Checkout\nSee [events](events.eventseq)."),
    ], JSON.stringify({
      format: "sequencediagrams-project", version: 1,
      resources: [
        { id: sequenceId, path: "architecture/checkout/order.seq", type: "sequence-diagram", title: "Checkout" },
        { id: flowId, path: "architecture/checkout/events.eventseq", type: "event-flow" },
        { id: "private-doc-id", path: "private/notes.md", type: "markdown-document" },
      ],
      semanticMessages: [{ id: "msg-place-order", name: "PlaceOrder", kind: "command" }, { id: "private-message", name: "PrivateMessage", kind: "event" }],
      relationships: [
        { kind: "complementary-view", sourceId: sequenceId, targetId: "private-doc-id" },
      ],
      unrelatedInternalField: "must not be projected",
    }), [
      { kind: "complementary-view", sourceId: sequenceId, targetId: flowId },
      { kind: "complementary-view", sourceId: sequenceId, targetId: "private-doc-id" },
    ]);

    expect(result.folders).toEqual(["architecture", "architecture/checkout"]);
    expect(result.catalog.resources.map((item) => item.id)).toEqual([flowId, sequenceId, "doc-order"]);
    expect(result.catalog.documents[0].headings).toEqual([{ level: 1, text: "Checkout", line: 1 }]);
    expect(result.catalog.relationships).toEqual([{ kind: "complementary-view", sourceId: sequenceId, targetId: flowId }]);
    expect(result.catalog.semanticMessages).toEqual([{ id: "msg-place-order", name: "PlaceOrder", kind: "command" }]);
    expect(result.catalog.semanticOccurrences).toMatchObject([{ messageRef: "msg-place-order", operation: "dispatch" }]);
    expect(result.catalog.semanticOccurrences?.some((item) => item.messageRef === "private-message")).toBe(false);
    expect(JSON.stringify(result)).not.toContain("private/notes.md");
    expect(JSON.stringify(result)).not.toContain("private-doc-id");
    expect(JSON.stringify(result)).not.toContain("unrelatedInternalField");

    const sequenceAst = analyze(sequence).ast!;
    expect(sequenceAst.participants.map((item) => item.id)).toEqual(["Buyer", "CheckoutService", "OrderDB"]);
    expect(sequenceAst.statements.some((item) => item.type === "alt")).toBe(true);
    expect(sequenceAst.notes[0].text).toContain("Order boundary");
    expect(result.catalog.semanticOccurrences).toHaveLength(1);

    const parsed = analyzeEventFlow(flow).flow;
    const flowView = projectEventFlowToFlowView(parsed);
    const topology = projectEventFlowToTopology(parsed);
    const causal = projectEventFlowToCausalView(parsed);
    expect(flowView.rows.find((row) => row.event === "DeclaredOnly")).toMatchObject({ producer: null, declaredOnly: true });
    expect(flowView.rows.some((row) => row.event === "OrderPlaced" && row.producer?.name === "CheckoutService" && row.consumers[0]?.name === "ShippingService")).toBe(true);
    expect(topology.connections[0]).toMatchObject({ producer: "CheckoutService", consumer: "ShippingService", events: [{ name: "OrderPlaced" }] });
    expect(causal.edges.map((edge) => edge.type)).toContain("MESSAGE_HANDLED_BY_HANDLER");
    expect(causal.edges.map((edge) => edge.type)).toContain("HANDLER_CAUSES_MESSAGE");
    expect(result.catalog.eventFlowCausality?.[0].view.edges).toEqual(causal.edges);

    const topologyOnly = analyzeEventFlow("event A\nevent B\nproducer P\nconsumer C\nP publishes A\nC consumes A\nP publishes B\nC consumes B").flow;
    expect(projectEventFlowToTopology(topologyOnly).connections).toHaveLength(1);
    expect(projectEventFlowToCausalView(topologyOnly).edges).toEqual([]);
  });

  it("keeps references and semantic traversal closed over current SHARED resource identities", () => {
    const result = buildPublicProjectProjection(projectId, [
      source(sequenceId, "shared.seq", "sequence-diagram", "participant A\nparticipant B\nA -> B: x\nsemantic event publish Created messageRef private-identity"),
      source(flowId, "flow.eventseq", "event-flow", "event Created messageRef private-identity\nproducer P\nP publishes Created"),
    ], JSON.stringify({
      format: "sequencediagrams-project", version: 1,
      resources: [{ id: sequenceId, path: "shared.seq", type: "sequence-diagram" }, { id: "retired", path: "old.md", type: "markdown-document" }],
      semanticMessages: [{ id: "known", name: "Known", kind: "event" }],
      relationships: [{ kind: "complementary-view", sourceId: sequenceId, targetId: "retired" }],
    }), [{ kind: "complementary-view", sourceId: sequenceId, targetId: "retired" }]);
    const resourceIds = new Set(result.resources.map((item) => item.id));
    for (const reference of result.catalog.references) {
      expect(resourceIds.has(reference.from)).toBe(true);
      if (reference.to !== null) expect(resourceIds.has(reference.to)).toBe(true);
    }
    for (const occurrence of result.catalog.semanticOccurrences ?? []) expect(occurrence.messageRef).toBeUndefined();
    for (const message of result.catalog.eventFlowMessages ?? []) expect(message.messageRef).toBeUndefined();
    for (const flowEntry of result.catalog.eventFlowCausality ?? []) {
      for (const message of flowEntry.view.messages) expect(message.messageRef).toBeUndefined();
    }
    expect(result.catalog.relationships).toEqual([]);
  });
});
