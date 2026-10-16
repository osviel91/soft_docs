import type { ArchitecturalProposal, ProposalReviewStatus } from "./architectural-proposal";
import type { Promotion } from "./promotion";

export type ProposalLifecycleState = "OPEN" | "CHANGES_REQUESTED" | "APPROVED" | "PROMOTING" | "PROMOTED" | "WITHDRAWN" | "SUPERSEDED";
export type ProposalLifecycleRecord = Pick<ArchitecturalProposal, "id" | "projectId" | "title" | "status" | "supersedesProposalId">;

export interface ProposalLineageEntry {
  id: string;
  title: string;
  status: ArchitecturalProposal["status"];
  supersedesProposalId?: string | null;
}

export type ProposalConsistencyCode =
  | "PROMOTION_ON_TERMINAL_PROPOSAL"
  | "COMPLETED_PROMOTION_MISSING_TIMESTAMP"
  | "PENDING_PROMOTION_HAS_COMPLETION_TIMESTAMP"
  | "LINEAGE_BROKEN_PREDECESSOR"
  | "LINEAGE_BROKEN_SUCCESSOR"
  | "LINEAGE_CYCLE"
  | "LINEAGE_DEPTH_LIMIT"
  | "LINEAGE_MULTIPLE_SUCCESSORS"
  | "OPEN_PROPOSAL_HAS_SUCCESSOR";

export interface ProposalConsistencyDiagnostic {
  code: ProposalConsistencyCode;
  message: string;
}

export interface ProposalLineage {
  entries: ProposalLineageEntry[];
  complete: boolean;
  diagnostics: ProposalConsistencyDiagnostic[];
}

export interface ProposalConsistency {
  state: "CONSISTENT" | "INCONSISTENT";
  diagnostics: ProposalConsistencyDiagnostic[];
}

export function deriveProposalLifecycle(
  status: ArchitecturalProposal["status"],
  reviewStatus: ProposalReviewStatus,
  promotionStatus?: Promotion["status"] | null,
): ProposalLifecycleState {
  if (status === "withdrawn") return "WITHDRAWN";
  if (status === "superseded") return "SUPERSEDED";
  if (promotionStatus === "COMPLETED") return "PROMOTED";
  if (promotionStatus === "COMMITTED_COMPLETION_PENDING") return "PROMOTING";
  if (reviewStatus === "changes-requested" || reviewStatus === "mixed") return "CHANGES_REQUESTED";
  if (reviewStatus === "approved") return "APPROVED";
  return "OPEN";
}

/** Build a bounded, same-project predecessor-to-successor chain without following arbitrary IDs. */
export function buildProposalLineage(
  current: ProposalLifecycleRecord,
  candidates: readonly ProposalLifecycleRecord[],
  maxDepth = 32,
): ProposalLineage {
  const sameProject = candidates.filter((proposal) => proposal.projectId === current.projectId);
  const byId = new Map(sameProject.map((proposal) => [proposal.id, proposal]));
  byId.set(current.id, current);
  const successors = new Map<string, ProposalLifecycleRecord[]>();
  for (const proposal of sameProject) {
    if (!proposal.supersedesProposalId) continue;
    const children = successors.get(proposal.supersedesProposalId) ?? [];
    children.push(proposal);
    successors.set(proposal.supersedesProposalId, children);
  }
  for (const children of successors.values()) children.sort((left, right) => left.id.localeCompare(right.id));

  const diagnostics: ProposalConsistencyDiagnostic[] = [];
  const visited = new Set([current.id]);
  const ancestors: ProposalLifecycleRecord[] = [];
  let cursor = current;
  let depth = 0;
  while (cursor.supersedesProposalId) {
    if (depth >= maxDepth) {
      diagnostics.push({ code: "LINEAGE_DEPTH_LIMIT", message: `Proposal lineage exceeds the ${maxDepth}-entry traversal bound.` });
      break;
    }
    const predecessorId = cursor.supersedesProposalId;
    if (visited.has(predecessorId)) {
      diagnostics.push({ code: "LINEAGE_CYCLE", message: `Proposal lineage cycles at ${predecessorId}.` });
      break;
    }
    const predecessor = byId.get(predecessorId);
    if (!predecessor) {
      diagnostics.push({ code: "LINEAGE_BROKEN_PREDECESSOR", message: `Predecessor ${predecessorId} is unavailable in this project.` });
      break;
    }
    visited.add(predecessor.id);
    ancestors.unshift(predecessor);
    cursor = predecessor;
    depth += 1;
  }

  const descendants: ProposalLifecycleRecord[] = [];
  cursor = current;
  depth = 0;
  while (depth <= maxDepth) {
    const children = successors.get(cursor.id) ?? [];
    if (children.length > 1) diagnostics.push({ code: "LINEAGE_MULTIPLE_SUCCESSORS", message: `Proposal ${cursor.id} has multiple successors.` });
    const successor = children[0];
    if (!successor) {
      if (cursor.status === "superseded") diagnostics.push({ code: "LINEAGE_BROKEN_SUCCESSOR", message: `Superseded proposal ${cursor.id} has no successor in this project.` });
      break;
    }
    if (cursor.id === current.id && current.status === "open") diagnostics.push({ code: "OPEN_PROPOSAL_HAS_SUCCESSOR", message: `Open proposal ${current.id} already has a successor.` });
    if (depth >= maxDepth) {
      diagnostics.push({ code: "LINEAGE_DEPTH_LIMIT", message: `Proposal lineage exceeds the ${maxDepth}-entry traversal bound.` });
      break;
    }
    if (visited.has(successor.id)) {
      diagnostics.push({ code: "LINEAGE_CYCLE", message: `Proposal lineage cycles at ${successor.id}.` });
      break;
    }
    visited.add(successor.id);
    descendants.push(successor);
    cursor = successor;
    depth += 1;
  }

  const entries = [...ancestors, current, ...descendants].map(({ id, title, status, supersedesProposalId }) => ({ id, title, status, supersedesProposalId }));
  return { entries, complete: diagnostics.length === 0, diagnostics };
}

export function evaluateProposalConsistency(
  status: ArchitecturalProposal["status"],
  promotion: Promotion | null,
  lineage: ProposalLineage,
): ProposalConsistency {
  const diagnostics = [...lineage.diagnostics];
  if (promotion && status !== "open") diagnostics.push({ code: "PROMOTION_ON_TERMINAL_PROPOSAL", message: `Proposal status ${status} conflicts with promotion evidence ${promotion.status}.` });
  if (promotion?.status === "COMPLETED" && !promotion.completedAt) diagnostics.push({ code: "COMPLETED_PROMOTION_MISSING_TIMESTAMP", message: "Completed promotion evidence has no completion timestamp." });
  if (promotion?.status === "COMMITTED_COMPLETION_PENDING" && promotion.completedAt) diagnostics.push({ code: "PENDING_PROMOTION_HAS_COMPLETION_TIMESTAMP", message: "Pending promotion evidence already has a completion timestamp." });
  return { state: diagnostics.length ? "INCONSISTENT" : "CONSISTENT", diagnostics };
}
