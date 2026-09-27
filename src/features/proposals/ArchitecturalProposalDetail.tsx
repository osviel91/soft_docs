import { useEffect, useState } from "react";
import type { ServerApiClient, ServerArchitecturalProposal } from "../../workspace/server/api-client";

export function ArchitecturalProposalDetail({ client, projectId, proposalId, onBack }: { client: ServerApiClient; projectId: string; proposalId: string; onBack: () => void }) {
  const [proposal, setProposal] = useState<ServerArchitecturalProposal | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void client.getArchitecturalProposal(projectId, proposalId).then((value) => { if (active) setProposal(value); }).catch((reason: unknown) => { if (active) setError(reason instanceof Error ? reason.message : "The proposal could not be loaded."); });
    return () => { active = false; };
  }, [client, projectId, proposalId]);
  if (error) return <section aria-label="Architectural Proposal"><button onClick={onBack}>Back</button><p>{error}</p></section>;
  if (!proposal) return <section aria-label="Architectural Proposal"><p>Loading proposal...</p></section>;
  return <section className="proposal-detail" aria-label="Architectural Proposal">
    <button onClick={onBack}>Back</button>
    <h2>{proposal.title}</h2>
    <p>{proposal.description ?? "No description."}</p>
    <dl>
      <dt>Status</dt><dd>{proposal.status} · non-authoritative</dd>
      <dt>Author</dt><dd>{proposal.authorUserId}</dd>
      <dt>Submitted</dt><dd>{new Date(proposal.submittedAt).toLocaleString()}</dd>
      <dt>SHARED base</dt><dd>{proposal.baseSharedRevision}</dd>
      <dt>Current SHARED</dt><dd>{proposal.currentSharedRevision ?? "Unknown"}</dd>
      <dt>Base status</dt><dd>{proposal.staleBase ? "Base has advanced" : "Current"}</dd>
    </dl>
    <h3>Submitted resources</h3>
    <ul>{proposal.resources.map((resource) => <li key={resource.sourceResourceId}>{resource.path} · revision {resource.sourceRevision}</li>)}</ul>
    <h3>Dependencies</h3>
    <p>{proposal.semanticMessages.length} semantic identities, {proposal.relationships.length} relationships.</p>
    <p>Use Analysis Workspace for architectural tracing and comparison.</p>
  </section>;
}
