import { describe, expect, it } from "vitest";
import { parseEventFlow } from "../../src/language/eventflow/parser";
import { projectEventFlowToCausalView } from "../../src/domain/eventflow/causal-projection";
import { classifyEffects, layoutCausalView, orthogonalEdgeIntersectsNode, selectCausalDensity } from "../../src/layout/causal-layout";

async function layout(source: string) {
  return layoutCausalView(projectEventFlowToCausalView(parseEventFlow(source).flow));
}

function pointOnBox(point: { x: number; y: number }, box: { x: number; y: number; width: number; height: number }) {
  const epsilon = 1;
  const horizontal = point.x >= box.x - epsilon && point.x <= box.x + box.width + epsilon;
  const vertical = point.y >= box.y - epsilon && point.y <= box.y + box.height + epsilon;
  return (Math.abs(point.x - box.x) <= epsilon || Math.abs(point.x - (box.x + box.width)) <= epsilon) && vertical
    || (Math.abs(point.y - box.y) <= epsilon || Math.abs(point.y - (box.y + box.height)) <= epsilon) && horizontal;
}

describe("layoutCausalView", () => {
  function overlaps(a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }) {
    return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
  }

  it("is deterministic and gives every semantic node unique geometry", async () => {
    const source = [
      "event A", "event B", "handler H", "A handled by H", "H causes B",
      "effect save on H kind state: save",
    ].join("\n");
    const first = await layout(source);
    expect(first).toEqual(await layout(source));
    expect(new Set(first.nodes.map((node) => `${node.box.x}:${node.box.y}`)).size).toBe(first.nodes.length);
  });

  it("keeps cycles finite and disconnected components separated", async () => {
    const result = await layout([
      "event A", "event B", "event Isolated", "handler H1", "handler H2",
      "A handled by H1", "H1 causes B", "B handled by H2", "H2 causes A",
    ].join("\n"));
    expect(result.nodes).toHaveLength(5);
    expect(result.edges).toHaveLength(4);
    expect(result.width).toBeGreaterThan(0);
    expect(result.height).toBeGreaterThan(0);
  });

  it("keeps effects subordinate to their handler instead of ranking them", async () => {
    const result = await layout([
      "event A", "event B", "handler H", "A handled by H", "H causes B",
      "effect save on H: Save state",
    ].join("\n"));
    const handler = result.nodes.find((node) => node.id === "handler:H")!;
    const effect = result.nodes.find((node) => node.id === "effect:save")!;
    expect(effect.box.y).toBeGreaterThan(handler.box.y + handler.box.height);
    expect(effect.box.x).toBeGreaterThanOrEqual(handler.box.x - effect.box.width);
  });

  it.each([
    ["UpOne fan-out", ["event Raised", "event SaveCommand", "event AddAccountCommand", "event AddCorporateAccountCommand", "handler Transactions", "handler Accounts", "Raised handled by Transactions", "Raised handled by Accounts", "Transactions causes SaveCommand", "Accounts causes AddAccountCommand", "Accounts causes AddCorporateAccountCommand", "effect save on Transactions: save transaction", "effect account on Accounts: update account"]],
    ["negative balance", ["event Created", "event ThresholdExceeded", "event SendEmailCommand {", "  kind: command", "}", "handler Criteria", "handler Notification", "Created handled by Criteria", "Criteria causes ThresholdExceeded", "ThresholdExceeded handled by Notification", "Notification causes SendEmailCommand", "effect ledger on Criteria: read ledger", "effect mail on Notification: send email"]],
    ["export fan-in", ["event A", "event B", "event C", "event Complete", "handler HA", "handler HB", "handler HC", "A handled by HA", "B handled by HB", "C handled by HC", "HA causes Complete", "HB causes Complete", "HC causes Complete"]],
    ["webhook retry", ["event RetryCommand {", "  kind: command", "  provenance: internal", "}", "event Retried", "handler Retry", "scheduled initiates RetryCommand", "RetryCommand handled by Retry", "Retry causes Retried", "effect find on Retry: find entries", "effect mark on Retry: mark retry success or failure"]],
  ])("keeps %s readable as a general graph", async (_name, lines) => {
    const result = await layout(lines.join("\n"));
    for (let left = 0; left < result.nodes.length; left++) {
      for (let right = left + 1; right < result.nodes.length; right++) {
        expect(overlaps(result.nodes[left].box, result.nodes[right].box)).toBe(false);
      }
    }
    expect(result.nodes.every((node) => node.lines.length > 0)).toBe(true);
    expect(result.edges.every((edge) => result.nodes.some((node) => node.id === edge.edge.from) && result.nodes.some((node) => node.id === edge.edge.to))).toBe(true);
  });

  it("wraps long labels within bounded node geometry", async () => {
    const result = await layout([
      "event VeryLongMessageNameThatShouldWrapAcrossSeveralLines",
      "handler VeryLongHandlerNameThatShouldWrapToo",
      "VeryLongMessageNameThatShouldWrapAcrossSeveralLines handled by VeryLongHandlerNameThatShouldWrapToo",
    ].join("\n"));
    expect(result.nodes.some((node) => node.lines.length > 1)).toBe(true);
    expect(Math.max(...result.nodes.map((node) => node.box.width))).toBeLessThanOrEqual(260);
  });

  it("groups several effects under their owning handler", async () => {
    const result = await layout([
      "event Raised", "handler Accounts", "Raised handled by Accounts",
      "effect save on Accounts: save transaction",
      "effect account on Accounts: update account",
      "effect audit on Accounts: write a very long audit record label that wraps",
      "effect notify on Accounts: notify downstream system",
    ].join("\n"));
    const handler = result.nodes.find((node) => node.id === "handler:Accounts")!;
    const group = result.effectGroups.find((entry) => entry.handlerId === handler.id)!;
    expect(group.effectIds).toHaveLength(4);
    for (const id of group.effectIds) {
      const effect = result.nodes.find((node) => node.id === id)!;
      expect(effect.box.y).toBeGreaterThan(handler.box.y + handler.box.height);
    }
    const effectEdges = result.edges.filter(({ edge }) => edge.type === "HANDLER_HAS_EFFECT");
    expect(effectEdges).toHaveLength(4);
    expect(new Set(effectEdges.map(({ edge }) => edge.from)).size).toBe(1);
  });

  it("keeps multiple handler effect groups separate", async () => {
    const result = await layout([
      "event Raised", "handler A", "handler B", "Raised handled by A", "Raised handled by B",
      "effect a1 on A: first", "effect a2 on A: second", "effect b1 on B: first", "effect b2 on B: second",
    ].join("\n"));
    expect(result.effectGroups.map((group) => group.effectIds.length)).toEqual([2, 2]);
    for (let left = 0; left < result.nodes.length; left++) {
      for (let right = left + 1; right < result.nodes.length; right++) {
        expect(overlaps(result.nodes[left].box, result.nodes[right].box)).toBe(false);
      }
    }
  });

  it.each([
    ["linear chain", ["event A", "event B", "handler H", "A handled by H", "H causes B"]],
    ["fan-out", ["event A", "event B", "event C", "handler H", "A handled by H", "H causes B", "H causes C"]],
    ["fan-in", ["event A", "event B", "event C", "handler HA", "handler HB", "A handled by HA", "B handled by HB", "HA causes C", "HB causes C"]],
    ["fan-out convergence", ["event A", "event B", "event C", "event D", "handler H", "handler HB", "handler HC", "A handled by H", "H causes B", "H causes C", "B handled by HB", "C handled by HC", "HB causes D", "HC causes D"]],
  ])("routes %s without node overlap", async (_name, lines) => {
    const result = await layout(lines.join("\n"));
    for (let left = 0; left < result.nodes.length; left++) {
      for (let right = left + 1; right < result.nodes.length; right++) expect(overlaps(result.nodes[left].box, result.nodes[right].box)).toBe(false);
    }
    const boxes = new Map(result.nodes.map((node) => [node.id, node.box]));
    expect(result.edges.every((entry) => entry.points.length >= 2
      && pointOnBox(entry.points[0], boxes.get(entry.edge.from)!)
      && pointOnBox(entry.points.at(-1)!, boxes.get(entry.edge.to)!))).toBe(true);
  });

  it("keeps failure and retry branches local and marks cycle back edges", async () => {
    const result = await layout([
      "event A", "event B", "handler H", "A handled by H", "H causes B",
      "failure processing-failed on handler H",
      "retry same-work for processing-failed {", "  mechanism: handler", "  target: same-execution", "}",
      "B handled by H",
    ].join("\n"));
    expect(result.edges.some((entry) => entry.edge.type === "FAILURE_RETRIED")).toBe(true);
    expect(result.edges.some((entry) => entry.backEdge)).toBe(true);
  });

  it.each([
    ["handler", "failure handler-failed on handler H"],
    ["message", "failure message-failed on message B"],
    ["effect", "failure effect-failed on effect save"],
  ])("routes failure targeting a %s and its retry", async (_target, failure) => {
    const result = await layout([
      "event A", "event B", "handler H", "A handled by H", "H causes B",
      "effect save on H: save state", failure,
      "retry again for "+failure.split(" ")[1]+" {", "  mechanism: handler", "  target: same-execution", "}",
    ].join("\n"));
    expect(result.nodes.length).toBeGreaterThan(3);
    expect(result.edges.some((entry) => entry.edge.type === "ENTITY_FAILED")).toBe(true);
    expect(result.edges.some((entry) => entry.edge.type === "FAILURE_RETRIED")).toBe(true);
  });

  it("supports retry reinitiating a message and retry targeting a handler", async () => {
    const result = await layout([
      "event Delivery", "event Retried", "handler Webhook", "Delivery handled by Webhook", "Webhook causes Retried",
      "failure delivery-failed on handler Webhook", "failure delivery-failed-again on handler Webhook",
      "retry delivery-again for delivery-failed {", "  mechanism: handler", "  target: same-execution", "  initiates: Delivery", "}",
      "retry delivery-handler-again for delivery-failed-again {", "  mechanism: handler", "  target: same-execution", "}",
    ].join("\n"));
    expect(result.edges.some((entry) => entry.edge.type === "RETRY_INITIATES_MESSAGE")).toBe(true);
    expect(result.edges.some((entry) => entry.edge.type === "RETRY_TARGETS_HANDLER")).toBe(true);
  });

  it("classifies an effect with a failure edge as structural", async () => {
    const result = await layout([
      "event A", "handler H", "A handled by H", "effect save on H: save state",
      "failure save-failed on effect save",
    ].join("\n"));
    const effect = result.nodes.find((node) => node.id === "effect:save")!;
    const failure = result.nodes.find((node) => node.id === "failure:save-failed")!;
    expect(effect.box).toBeDefined();
    expect(result.edges.some((entry) => entry.edge.from === effect.id && entry.edge.to === failure.id)).toBe(true);
    expect(classifyEffects([effect.id], projectEventFlowToCausalView(parseEventFlow([
      "event A", "handler H", "A handled by H", "effect save on H: save state", "failure save-failed on effect save",
    ].join("\n")).flow).edges).structural.has(effect.id)).toBe(true);
  });

  it("packs disconnected components and preserves isolated messages", async () => {
    const result = await layout(["event A", "event B", "handler H", "A handled by H", "H causes B", "event Isolated"].join("\n"));
    const isolated = result.nodes.find((node) => node.id === "message:Isolated")!;
    const connected = result.nodes.filter((node) => node.id !== isolated.id);
    expect(isolated).toBeDefined();
    expect(isolated.box.y > Math.max(...connected.map((node) => node.box.y + node.box.height)) || isolated.box.y < Math.min(...connected.map((node) => node.box.y))).toBe(true);
  });

  it("keeps a large programmed-recharge-shaped graph bounded", async () => {
    const result = await layout([
      "event RechargeRequested", "event BalanceLoaded", "event RechargeAuthorized", "event RechargeRejected", "event PaymentCaptured", "event RechargeCompleted", "event NotificationQueued", "event LedgerUpdated",
      "handler LoadBalance", "handler AuthorizeRecharge", "handler CapturePayment", "handler CompleteRecharge", "handler NotifyCustomer",
      "RechargeRequested handled by LoadBalance", "LoadBalance causes BalanceLoaded", "BalanceLoaded handled by AuthorizeRecharge", "AuthorizeRecharge causes RechargeAuthorized", "AuthorizeRecharge causes RechargeRejected", "RechargeAuthorized handled by CapturePayment", "CapturePayment causes PaymentCaptured", "PaymentCaptured handled by CompleteRecharge", "CompleteRecharge causes RechargeCompleted", "RechargeCompleted handled by NotifyCustomer", "NotifyCustomer causes NotificationQueued", "CompleteRecharge causes LedgerUpdated", "LedgerUpdated handled by NotifyCustomer",
      "failure capture-failed on handler CapturePayment", "retry capture-again for capture-failed {", "  mechanism: handler", "  target: same-execution", "}",
      "effect persist on CompleteRecharge: persist recharge", "effect audit on CompleteRecharge: append audit record",
    ].join("\n"));
    expect(result.width).toBeLessThan(3200);
    expect(result.height).toBeLessThan(3200);
    expect(result.width / result.height).toBeLessThan(8);
    expect(result.edges.every((entry) => entry.points.length >= 2)).toBe(true);
    expect(result.nodes.filter((node) => node.type === "effect").every((effect) => {
      const owner = result.nodes.find((node) => node.id === result.edges.find((edge) => edge.edge.to === effect.id)?.edge.from);
      return owner ? effect.box.y > owner.box.y + owner.box.height : false;
    })).toBe(true);
  });

  it("keeps small graphs spacious and compacts sufficiently deep graphs", async () => {
    const small = projectEventFlowToCausalView(parseEventFlow([
      "event A", "handler H", "A handled by H",
    ].join("\n")).flow);
    const deep = projectEventFlowToCausalView(parseEventFlow([
      "event A", "event B", "event C", "event D", "event E", "event F", "event G",
      "handler H1", "handler H2", "handler H3", "handler H4", "handler H5", "handler H6",
      "A handled by H1", "H1 causes B", "B handled by H2", "H2 causes C", "C handled by H3", "H3 causes D",
      "D handled by H4", "H4 causes E", "E handled by H5", "H5 causes F", "F handled by H6", "H6 causes G",
    ].join("\n")).flow);
    expect(selectCausalDensity(small).name).toBe("normal");
    expect(selectCausalDensity(deep).name).toBe("compact");
    expect((await layoutCausalView(deep)).width).toBeLessThan((await layoutCausalView(small)).width * 8);
  });

  it("packs recharge-shaped primary and independent components into a tighter canvas", async () => {
    const result = await layout([
      "event RechargeRequested", "event BalanceLoaded", "event RechargeAuthorized", "event PaymentCaptured", "event RechargeCompleted",
      "handler LoadBalance", "handler AuthorizeRecharge", "handler CapturePayment", "handler CompleteRecharge",
      "RechargeRequested handled by LoadBalance", "LoadBalance causes BalanceLoaded", "BalanceLoaded handled by AuthorizeRecharge",
      "AuthorizeRecharge causes RechargeAuthorized", "RechargeAuthorized handled by CapturePayment", "CapturePayment causes PaymentCaptured",
      "PaymentCaptured handled by CompleteRecharge", "CompleteRecharge causes RechargeCompleted",
      "event AuditTrail", "event CustomerPreference", "event BillingClock", "event IndependentNotification",
    ].join("\n"));
    const boxes = result.nodes.map((node) => node.box);
    for (let left = 0; left < boxes.length; left++) {
      for (let right = left + 1; right < boxes.length; right++) expect(overlaps(boxes[left], boxes[right])).toBe(false);
    }
    expect(result.width).toBeGreaterThan(Math.max(...boxes.map((box) => box.width)) + 100);
    expect(result.height).toBeLessThan(result.nodes.length * 180);
  });

  it("keeps a wide dominant component from spreading secondary components", async () => {
    const result = await layout([
      "event A", "event B", "event C", "event D", "event E", "handler H",
      "A handled by H", "H causes B", "B handled by H", "H causes C", "C handled by H", "H causes D", "D handled by H", "H causes E",
      "event SmallOne", "event SmallTwo", "event SmallThree",
    ].join("\n"));
    const primary = result.nodes.filter((node) => ["message:A", "message:B", "message:C", "message:D", "message:E", "handler:H"].includes(node.id));
    const secondary = result.nodes.filter((node) => ["message:SmallOne", "message:SmallTwo", "message:SmallThree"].includes(node.id));
    const primaryWidth = Math.max(...primary.map((node) => node.box.x + node.box.width)) - Math.min(...primary.map((node) => node.box.x));
    const secondaryWidth = Math.max(...secondary.map((node) => node.box.x + node.box.width)) - Math.min(...secondary.map((node) => node.box.x));
    expect(secondaryWidth).toBeLessThan(primaryWidth);
  });

  it("has no unintended orthogonal edge-through-node intersections", async () => {
    const result = await layout([
      "event A", "event B", "event C", "handler H", "handler J", "A handled by H", "H causes B",
      "B handled by J", "J causes C", "effect save on H: save state", "effect audit on J: audit state",
    ].join("\n"));
    for (const entry of result.edges) {
      for (const node of result.nodes) {
        if (node.id !== entry.edge.from && node.id !== entry.edge.to) {
          expect(orthogonalEdgeIntersectsNode(entry.points, node.box)).toBe(false);
        }
      }
    }
  });

  it.each([
    ["Monthly Billing", ["event InvoiceDue", "event InvoiceIssued", "handler Billing", "InvoiceDue handled by Billing", "Billing causes InvoiceIssued", "effect ledger on Billing: update ledger"]],
    ["Export Completion", ["event ExportRequested", "event ExportCompleted", "handler Export", "ExportRequested handled by Export", "Export causes ExportCompleted", "effect archive on Export: archive export"]],
    ["Webhook Delivery Retry", ["event Delivery", "event Retried", "handler Webhook", "Delivery handled by Webhook", "Webhook causes Retried", "effect notify on Webhook: notify webhook", "failure notify-failed on effect notify", "retry notify-again for notify-failed {", "  mechanism: handler", "  target: same-execution", "}"]],
  ])("renders %s without node or edge-through-node collisions", async (_name, lines) => {
    const result = await layout(lines.join("\n"));
    for (let left = 0; left < result.nodes.length; left++) {
      for (let right = left + 1; right < result.nodes.length; right++) expect(overlaps(result.nodes[left].box, result.nodes[right].box)).toBe(false);
    }
    for (const entry of result.edges) {
      for (const node of result.nodes) {
        if (node.id !== entry.edge.from && node.id !== entry.edge.to) expect(orthogonalEdgeIntersectsNode(entry.points, node.box)).toBe(false);
      }
    }
  });
});
