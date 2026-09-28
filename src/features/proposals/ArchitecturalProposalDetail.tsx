import { useEffect, useState } from "react";
import type { ServerApiClient, ServerArchitecturalProposal, ServerProposalReviewSummary, ServerPromotionPreview } from "../../workspace/server/api-client";
import { operationSymbol, proposalChangeSummary } from "./proposal-change-summary";

export function ArchitecturalProposalDetail({ client, projectId, proposalId, onBack, onChanged, onOpenShared }: { client: ServerApiClient; projectId: string; proposalId: string; onBack: () => void; onChanged?: () => void; onOpenShared?: () => void }) {
  const [proposal, setProposal] = useState<ServerArchitecturalProposal | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reviews, setReviews] = useState<ServerProposalReviewSummary | null>(null);
  const [decision, setDecision] = useState<"APPROVE" | "REQUEST_CHANGES">("REQUEST_CHANGES");
  const [summary, setSummary] = useState("");
  const [promotion, setPromotion] = useState<ServerPromotionPreview | null>(null);
  const [promoted, setPromoted] = useState(false);
  useEffect(() => {
    let active = true;
    void Promise.all([client.getArchitecturalProposal(projectId, proposalId), client.getArchitecturalProposalReviews(projectId, proposalId)]).then(([value, reviewSummary]) => { if (active) { setProposal(value); setReviews(reviewSummary); } }).catch((reason: unknown) => { if (active) setError(reason instanceof Error ? reason.message : "The proposal could not be loaded."); });
    return () => { active = false; };
  }, [client, projectId, proposalId]);
  if (error) return <section aria-label="Architectural Proposal"><button onClick={onBack}>Back</button><p>{error}</p></section>;
  if (!proposal) return <section aria-label="Architectural Proposal"><p>Loading proposal...</p></section>;
  const submitReview = async () => { try { await client.reviewArchitecturalProposal(projectId, proposalId, { decision, ...(summary.trim() ? { summary: summary.trim() } : {}) }); setReviews(await client.getArchitecturalProposalReviews(projectId, proposalId)); setSummary(""); onChanged?.(); } catch (reason) { setError(reason instanceof Error ? reason.message : "The review could not be submitted."); } };
  const previewPromotion = async () => { try { setPromotion(await client.previewArchitecturalProposalPromotion(projectId, proposalId)); } catch (reason) { setError(reason instanceof Error ? reason.message : "The promotion preview could not be loaded."); } };
  const promote = async () => { try { await client.promoteArchitecturalProposal(projectId, proposalId); setPromoted(true); setPromotion(await client.previewArchitecturalProposalPromotion(projectId, proposalId)); onChanged?.(); } catch (reason) { setError(reason instanceof Error ? reason.message : "The proposal could not be promoted."); } };
  const changes = proposalChangeSummary(proposal, promotion);
  const reviewLocked = promoted;
  const reviewCapability = proposal.capabilities?.["proposal.review"];
  const promoteCapability = proposal.capabilities?.["proposal.promote"];
  return <section className="proposal-detail" aria-label="Architectural Proposal">
     <button type="button" onClick={onBack}>Back to proposals</button>
     <h2>{proposal.title}</h2>
     <p>{proposal.description ?? "No description."}</p>
     <dl className="proposal-detail__facts">
       <dt>Status</dt><dd>{promoted ? "PROMOTED" : (reviews?.status === "approved" ? "APPROVED" : reviews?.status === "changes-requested" ? "CHANGES REQUESTED" : "OPEN")} · {promoted ? "authoritative outcome" : "non-authoritative"}</dd>
       <dt>Author</dt><dd>Project member</dd>
       <dt>Submitted</dt><dd>{new Date(proposal.submittedAt).toLocaleString()}</dd>
     </dl>
     <section className="proposal-detail__changes" aria-label="Changes"><h3>Changes</h3><h4>Resources</h4><ChangeList items={changes.resources} /><h4>Relationships</h4><ChangeList items={changes.relationships} /><h4>Semantic identities</h4><ChangeList items={changes.semantic} /></section>
     <section aria-label="Base status"><h3>Base status</h3><p>{proposal.staleBase ? "Stale: SHARED has changed since submission." : "Current: proposal base matches SHARED."}</p></section>
      <section aria-label="Proposal promotion"><h3>Promotion preview</h3><p>Promotion is a separate explicit operation and is the only action that can change SHARED.</p><button type="button" onClick={() => void previewPromotion()}>Preview promotion</button>{promotion && <><p>{promotion.eligible ? "Ready to promote" : "Promotion blocked"} · review {promotion.reviewStatus}</p>{promotion.blockers.length > 0 && <><h4>Why it is blocked</h4><ul>{promotion.blockers.map((blocker) => <li key={`${blocker.code}-${blocker.message}`}><strong>{blocker.code.replaceAll("_", " ")}</strong>: {blocker.message}</li>)}</ul></>}{promotion.eligible && promoteCapability?.allowed && !reviewLocked && <button type="button" onClick={() => void promote()}>Promote to SHARED</button>}{promotion.eligible && promoteCapability && !promoteCapability.allowed && !reviewLocked && <p>{promoteCapability.reason === "forbidden" ? "Promotion is available only to the project owner." : "Promotion is not currently available."}</p>}{reviewLocked && <><p role="status">PROMOTED. The resulting knowledge is now authoritative in SHARED.</p>{onOpenShared && <button type="button" onClick={onOpenShared}>Open resulting SHARED knowledge</button>}</>}</>}</section>
     <section aria-label="Proposal review">
      <h3>Review evidence</h3>
      <p>{reviews?.status ?? "none"} · {reviews?.approvals ?? 0} approvals · {reviews?.changesRequested ?? 0} changes requested</p>
       <ul>{reviews?.reviews.map((review) => <li key={review.id}><strong>{review.decision === "APPROVE" ? "Approved" : "Changes requested"}</strong> by {review.reviewerDisplayName ?? "reviewer"} on {new Date(review.createdAt).toLocaleString()}{review.summary ? `: ${review.summary}` : ""}</li>)}</ul>
        {!reviewLocked && reviewCapability?.allowed && <fieldset><legend>Record review decision</legend><label><input type="radio" checked={decision === "APPROVE"} onChange={() => setDecision("APPROVE")} /> Approve</label><label><input type="radio" checked={decision === "REQUEST_CHANGES"} onChange={() => setDecision("REQUEST_CHANGES")} /> Request changes</label><textarea value={summary} onChange={(event) => setSummary(event.target.value)} placeholder="Review summary (recommended)" maxLength={4000} /><button type="button" onClick={() => void submitReview()}>Record {decision === "APPROVE" ? "approval" : "change request"}</button><p>Approval does not promote the proposal and does not modify SHARED.</p></fieldset>}
     </section>
     <details className="proposal-detail__technical"><summary>Technical details</summary><dl><dt>Author identity</dt><dd>{proposal.authorUserId}</dd><dt>Base SHARED revision</dt><dd>{proposal.baseSharedRevision}</dd><dt>Current SHARED revision</dt><dd>{proposal.currentSharedRevision ?? "Unknown"}</dd><dt>Resources in snapshot</dt><dd>{proposal.resources.map((resource) => `${resource.path} (r${resource.sourceRevision})`).join(", ")}</dd></dl></details>
     {error && <p role="alert">{error}</p>}
  </section>;
}

function ChangeList({ items }: { items: Array<{ operation: string; label: string }> }) {
  return items.length === 0 ? <p>No reported changes.</p> : <ul>{items.map((item, index) => <li key={`${item.operation}-${item.label}-${index}`}><strong>{operationSymbol[item.operation] ?? ""} {item.operation}</strong> {item.label}</li>)}</ul>;
}
