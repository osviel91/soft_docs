import type { ServerArchitecturalProposal, ServerPromotionPreview } from "../../workspace/server/api-client";

export type ProposalChangeKind = "CREATE" | "UPDATE" | "MOVE" | "RETIRE";

export interface ProposalChangeSummary {
  resources: Array<{ operation: ProposalChangeKind; label: string }>;
  relationships: Array<{ operation: "ADD" | "UPDATE" | "REMOVE"; label: string }>;
  semantic: Array<{ operation: "ADD" | "UPDATE" | "RETIRE"; label: string }>;
}

export function proposalChangeSummary(
  proposal: ServerArchitecturalProposal,
  promotion?: ServerPromotionPreview | null,
): ProposalChangeSummary {
  const resources = promotion
    ? [
        ...promotion.creates.map((entry) => ({ operation: "CREATE" as const, label: entry.path })),
        ...promotion.updates.map((entry) => ({ operation: "UPDATE" as const, label: entry.path })),
        ...promotion.retires.map((entry) => ({ operation: "RETIRE" as const, label: entry.path })),
      ]
    : proposal.resources.map((resource) => ({
        operation: resource.operation ?? "UPDATE",
        label: resource.path,
      }));
  const resourceNames = new Map(proposal.resources.map((resource) => [resource.sourceResourceId, resource.path]));
  return {
    resources,
    relationships: (promotion?.relationships ?? proposal.relationships.map((relationship) => ({ operation: "ADD" as const, relationship }))).map((change) => ({
      operation: change.operation,
      label: `${resourceNames.get(change.relationship.sourceId) ?? change.relationship.sourceId} -> ${resourceNames.get(change.relationship.targetId) ?? change.relationship.targetId} (${change.relationship.kind}${change.relationship.sourceRole || change.relationship.targetRole ? `, ${change.relationship.sourceRole ?? "other"}/${change.relationship.targetRole ?? "other"}` : ""})`,
    })),
    semantic: (promotion?.semanticChanges ?? proposal.semanticMessages.map((message) => ({ operation: "ADD" as const, message }))).map((change) => ({
      operation: change.operation,
      label: `${change.message.name} (${change.message.kind})`,
    })),
  };
}

export const operationSymbol: Record<string, string> = {
  CREATE: "+",
  UPDATE: "~",
  MOVE: "->",
  RETIRE: "-",
  ADD: "+",
  REMOVE: "-",
};
