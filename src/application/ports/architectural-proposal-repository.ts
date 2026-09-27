import type {
  ArchitecturalProposal,
  ArchitecturalProposalSummary,
} from "../../domain/workspace/architectural-proposal";

export interface ProposalSelection {
  resourceId: string;
  expectedRevision: number;
}

export interface ArchitecturalProposalRepository {
  submit(input: {
    projectId: string;
    authorUserId: string;
    sourcePrivateContextId: string;
    title: string;
    description?: string;
    selections: ProposalSelection[];
    privateMessageIds: string[];
    baseSharedRevision: string;
    baseSharedResourceRevisions: Record<string, number>;
  }): Promise<ArchitecturalProposal>;
  list(projectId: string): Promise<ArchitecturalProposalSummary[]>;
  get(projectId: string, proposalId: string): Promise<ArchitecturalProposal | null>;
  hasForContext(projectId: string, contextId: string): Promise<boolean>;
  currentSharedRevision(projectId: string): Promise<{ revision: string; resources: Record<string, number> }>;
}
