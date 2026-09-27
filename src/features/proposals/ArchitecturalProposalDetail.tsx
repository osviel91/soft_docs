import { useEffect, useState } from "react";
import type { ServerApiClient, ServerArchitecturalProposal, ServerProposalReviewSummary, ServerPromotionPreview } from "../../workspace/server/api-client";

export function ArchitecturalProposalDetail({ client, projectId, proposalId, onBack }: { client: ServerApiClient; projectId: string; proposalId: string; onBack: () => void }) {
  const [proposal, setProposal] = useState<ServerArchitecturalProposal | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reviews, setReviews] = useState<ServerProposalReviewSummary | null>(null);
  const [decision, setDecision] = useState<"APPROVE" | "REQUEST_CHANGES">("REQUEST_CHANGES");
  const [summary, setSummary] = useState("");
  const [promotion, setPromotion] = useState<ServerPromotionPreview | null>(null);
  useEffect(() => {
    let active = true;
    void Promise.all([client.getArchitecturalProposal(projectId, proposalId), client.getArchitecturalProposalReviews(projectId, proposalId)]).then(([value, reviewSummary]) => { if (active) { setProposal(value); setReviews(reviewSummary); } }).catch((reason: unknown) => { if (active) setError(reason instanceof Error ? reason.message : "The proposal could not be loaded."); });
    return () => { active = false; };
  }, [client, projectId, proposalId]);
  if (error) return <section aria-label="Architectural Proposal"><button onClick={onBack}>Back</button><p>{error}</p></section>;
  if (!proposal) return <section aria-label="Architectural Proposal"><p>Loading proposal...</p></section>;
  const submitReview = async () => { try { await client.reviewArchitecturalProposal(projectId, proposalId, { decision, ...(summary.trim() ? { summary: summary.trim() } : {}) }); setReviews(await client.getArchitecturalProposalReviews(projectId, proposalId)); setSummary(""); } catch (reason) { setError(reason instanceof Error ? reason.message : "The review could not be submitted."); } };
  const previewPromotion = async () => { try { setPromotion(await client.previewArchitecturalProposalPromotion(projectId, proposalId)); } catch (reason) { setError(reason instanceof Error ? reason.message : "The promotion preview could not be loaded."); } };
  const promote = async () => { try { await client.promoteArchitecturalProposal(projectId, proposalId); setPromotion(await client.previewArchitecturalProposalPromotion(projectId, proposalId)); } catch (reason) { setError(reason instanceof Error ? reason.message : "The proposal could not be promoted."); } };
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
     <ul>{proposal.resources.map((resource) => <li key={resource.sourceResourceId}><strong>{resource.operation ?? "UNCLASSIFIED"}</strong> {resource.path} · revision {resource.sourceRevision}{resource.operation === "RETIRE" ? " · leaves current SHARED knowledge; history is preserved" : ""}</li>)}</ul>
    <h3>Dependencies</h3>
    <p>{proposal.semanticMessages.length} semantic identities, {proposal.relationships.length} relationships.</p>
      <p>Use Analysis Workspace for architectural tracing and comparison.</p>
      <section aria-label="Proposal promotion"><h3>Promotion</h3><button type="button" onClick={() => void previewPromotion()}>Preview promotion</button>{promotion && <><p>{promotion.eligible ? "Eligible" : "Blocked"} · {promotion.reviewStatus}</p><ul>{promotion.blockers.map((blocker) => <li key={`${blocker.code}-${blocker.message}`}>{blocker.message}</li>)}</ul>{promotion.eligible && <button type="button" onClick={() => void promote()}>Promote to SHARED</button>}</>}</section>
    <section aria-label="Proposal review">
      <h3>Review evidence</h3>
      <p>{reviews?.status ?? "none"} · {reviews?.approvals ?? 0} approvals · {reviews?.changesRequested ?? 0} changes requested</p>
      <ul>{reviews?.reviews.map((review) => <li key={review.id}>{review.reviewerDisplayName ?? review.reviewerUserId} — {review.decision} {review.summary ? `"${review.summary}"` : ""}</li>)}</ul>
      <fieldset><legend>Review Proposal</legend><label><input type="radio" checked={decision === "APPROVE"} onChange={() => setDecision("APPROVE")} /> Approve</label><label><input type="radio" checked={decision === "REQUEST_CHANGES"} onChange={() => setDecision("REQUEST_CHANGES")} /> Request changes</label><textarea value={summary} onChange={(event) => setSummary(event.target.value)} placeholder="Summary" maxLength={4000} /><button type="button" onClick={() => void submitReview()}>Submit review</button></fieldset>
    </section>
    {error && <p role="alert">{error}</p>}
  </section>;
}
