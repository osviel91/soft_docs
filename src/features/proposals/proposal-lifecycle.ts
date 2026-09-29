import type { ServerArchitecturalProposal, ServerProposalReviewSummary } from "../../workspace/server/api-client";

export type ProposalLifecycleState = NonNullable<ServerArchitecturalProposal["lifecycle"]>["state"];

export function proposalLifecycle(
  proposal: Pick<ServerArchitecturalProposal, "status" | "lifecycle">,
  reviews?: Pick<ServerProposalReviewSummary, "status"> | null,
): ProposalLifecycleState {
  if (proposal.lifecycle?.state) return proposal.lifecycle.state;
  if (proposal.status === "withdrawn") return "WITHDRAWN";
  if (proposal.status === "superseded") return "SUPERSEDED";
  if (reviews?.status === "changes-requested") return "CHANGES_REQUESTED";
  if (reviews?.status === "approved") return "APPROVED";
  return "OPEN";
}

export function lifecycleReason(state: ProposalLifecycleState): string {
  switch (state) {
    case "PROMOTING": return "Promotion is currently completing.";
    case "PROMOTED": return "The resulting knowledge is authoritative in SHARED.";
    case "WITHDRAWN": return "This proposal remains historical evidence and cannot be reviewed or promoted.";
    case "SUPERSEDED": return "A newer proposal superseded this proposal.";
    default: return "";
  }
}
