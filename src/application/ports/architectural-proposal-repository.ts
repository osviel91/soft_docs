import type {
  ArchitecturalProposal,
  ArchitecturalProposalSummary,
} from "../../domain/workspace/architectural-proposal";

export interface ProposalSelection {
  resourceId: string;
  expectedRevision: number;
  operation?: "CREATE" | "UPDATE";
  baseResourceId?: string;
  path?: string;
  baseRevision?: number;
}

export interface ProposalRetirementSelection {
  resourceId: string;
  expectedRevision: number;
}

export type ProposalSemanticBindingSelection =
  | { operation: "ADD"; bindingId: string; sourceRevision: number }
  | { operation: "UPDATE"; bindingId: string; sourceRevision: number; expectedRevision: number; baseFingerprint: string }
  | { operation: "REMOVE"; bindingId: string; expectedRevision: number; baseFingerprint: string };

export interface ArchitecturalProposalRepository {
  submit(input: {
    projectId: string;
    authorUserId: string;
    sourcePrivateContextId: string;
    title: string;
    description?: string;
    selections: ProposalSelection[];
    retirements?: ProposalRetirementSelection[];
    privateMessageIds: string[];
    baseSharedRevision: string;
    baseSharedResourceRevisions: Record<string, number>;
    baseManifestRevision: number;
    semanticMessages?: Array<{ id: string; name: string; kind: "event" | "command"; operation?: "ADD" | "UPDATE" | "RETIRE"; baseName?: string; baseKind?: "event" | "command" }>;
    relationships?: Array<{ sourceId: string; targetId: string; kind: "complementary-view"; sourceRole?: "execution" | "causal" | "other"; targetRole?: "execution" | "causal" | "other"; operation?: "ADD" | "UPDATE" | "REMOVE"; baseFingerprint?: string }>;
    semanticBindings?: ProposalSemanticBindingSelection[];
  }): Promise<ArchitecturalProposal>;
  revise?(input: {
    proposalId: string;
    supersedesProposalId: string;
    projectId: string;
    authorUserId: string;
    sourcePrivateContextId: string;
    title: string;
    description?: string;
    selections: ProposalSelection[];
    retirements?: ProposalRetirementSelection[];
    privateMessageIds: string[];
    baseSharedRevision: string;
    baseSharedResourceRevisions: Record<string, number>;
    baseManifestRevision: number;
    semanticMessages?: Array<{ id: string; name: string; kind: "event" | "command"; operation?: "ADD" | "UPDATE" | "RETIRE"; baseName?: string; baseKind?: "event" | "command" }>;
    relationships?: Array<{ sourceId: string; targetId: string; kind: "complementary-view"; sourceRole?: "execution" | "causal" | "other"; targetRole?: "execution" | "causal" | "other"; operation?: "ADD" | "UPDATE" | "REMOVE"; baseFingerprint?: string }>;
    semanticBindings?: ProposalSemanticBindingSelection[];
  }): Promise<ArchitecturalProposal>;
  withdraw?(proposalId: string, authorUserId: string, reason?: string): Promise<ArchitecturalProposal>;
  list(projectId: string): Promise<ArchitecturalProposalSummary[]>;
  get(projectId: string, proposalId: string): Promise<ArchitecturalProposal | null>;
  findSuccessor?(projectId: string, proposalId: string): Promise<ArchitecturalProposal | null>;
  hasForContext(projectId: string, contextId: string): Promise<boolean>;
  currentSharedRevision(projectId: string): Promise<{ revision: string; resources: Record<string, number> }>;
}
