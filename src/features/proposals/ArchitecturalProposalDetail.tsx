import { useEffect, useState } from "react";
import type { ServerApiClient, ServerArchitecturalProposal, ServerProposalReviewSummary, ServerPromotionPreview } from "../../workspace/server/api-client";
import { operationSymbol, proposalChangeSummary } from "./proposal-change-summary";
import { lifecycleReason, proposalLifecycle, type ProposalLifecycleState } from "./proposal-lifecycle";
import Preview from "../preview/Preview";
import EventFlowPreview from "../preview/EventFlowPreview";
import { resourceRepresentationOfType } from "../../domain/workspace/resource-id";
import type { ServerArchitecturalProposalDiff, ServerArchitecturalProposalDiffResource } from "../../workspace/server/api-client";

interface Props {
  client: ServerApiClient;
  projectId: string;
  proposalId: string;
  onBack: () => void;
  onChanged?: () => void | Promise<void>;
  onOpenShared?: () => void;
  onOpenProposal?: (proposalId: string) => void;
  onRevise?: (contextId: string, proposalId: string, resourceId: string | null) => void;
}

export function ArchitecturalProposalDetail({ client, projectId, proposalId, onBack, onChanged, onOpenShared, onOpenProposal, onRevise }: Props) {
  const [proposal, setProposal] = useState<ServerArchitecturalProposal | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reviews, setReviews] = useState<ServerProposalReviewSummary | null>(null);
  const [decision, setDecision] = useState<"APPROVE" | "REQUEST_CHANGES">("REQUEST_CHANGES");
  const [summary, setSummary] = useState("");
  const [withdrawReason, setWithdrawReason] = useState("");
  const [withdrawOpen, setWithdrawOpen] = useState(false);
  const [promotion, setPromotion] = useState<ServerPromotionPreview | null>(null);
  const [diff, setDiff] = useState<ServerArchitecturalProposalDiff | null>(null);
  const [selectedDiffPath, setSelectedDiffPath] = useState<string | null>(null);

  const reload = async () => {
    const [value, reviewSummary] = await Promise.all([client.getArchitecturalProposal(projectId, proposalId), client.getArchitecturalProposalReviews(projectId, proposalId)]);
    setProposal(value);
    setReviews(reviewSummary);
  };

  useEffect(() => {
    let active = true;
    void Promise.all([client.getArchitecturalProposal(projectId, proposalId), client.getArchitecturalProposalReviews(projectId, proposalId)]).then(([value, reviewSummary]) => { if (active) { setProposal(value); setReviews(reviewSummary); setError(null); } }).catch((reason: unknown) => { if (active) setError(reason instanceof Error ? reason.message : "The proposal could not be loaded."); });
    return () => { active = false; };
  }, [client, projectId, proposalId]);

  useEffect(() => {
    let active = true;
    setDiff(null);
    if (typeof client.getArchitecturalProposalDiff !== "function") return () => { active = false; };
    void client.getArchitecturalProposalDiff(projectId, proposalId).then((value) => { if (active) setDiff(value); }).catch(() => { if (active) setError("The proposal comparison could not be loaded."); });
    return () => { active = false; };
  }, [client, projectId, proposalId]);

  if (error) return <section aria-label="Architectural Proposal"><button type="button" onClick={onBack}>Back</button><p role="alert">{error}</p></section>;
  if (!proposal) return <section aria-label="Architectural Proposal"><p>Loading proposal...</p></section>;

  const state: ProposalLifecycleState = proposalLifecycle(proposal, reviews);
  const reviewLocked = ["PROMOTING", "PROMOTED", "WITHDRAWN", "SUPERSEDED"].includes(state);
  const changes = proposalChangeSummary(proposal, promotion);
  const reviewCapability = proposal.capabilities?.["proposal.review"];
  const reviseCapability = proposal.capabilities?.["proposal.revise"];
  const withdrawCapability = proposal.capabilities?.["proposal.withdraw"];
  const previewCapability = proposal.capabilities?.["proposal.previewPromotion"];
  const promoteCapability = proposal.capabilities?.["proposal.promote"];

  const submitReview = async () => { try { await client.reviewArchitecturalProposal(projectId, proposalId, { decision, ...(summary.trim() ? { summary: summary.trim() } : {}) }); setSummary(""); await reload(); await onChanged?.(); } catch (reason) { setError(reason instanceof Error ? reason.message : "The review could not be submitted."); } };
  const previewPromotion = async () => { try { setPromotion(await client.previewArchitecturalProposalPromotion(projectId, proposalId)); } catch (reason) { setError(reason instanceof Error ? reason.message : "The promotion preview could not be loaded."); } };
  const promote = async () => { try { await client.promoteArchitecturalProposal(projectId, proposalId); await reload(); setPromotion(await client.previewArchitecturalProposalPromotion(projectId, proposalId)); await onChanged?.(); } catch (reason) { setError(reason instanceof Error ? reason.message : "The proposal could not be promoted."); } };
  const withdraw = async () => { try { await client.withdrawArchitecturalProposal(projectId, proposalId, withdrawReason.trim()); setWithdrawOpen(false); setWithdrawReason(""); await reload(); await onChanged?.(); } catch (reason) { setError(reason instanceof Error ? reason.message : "The proposal could not be withdrawn."); } };

  return <section className="proposal-detail" aria-label="Architectural Proposal">
    <button type="button" onClick={onBack}>Back to proposals</button>
    <p className="governance-eyebrow">PROPOSAL DETAIL</p>
    <h2>{proposal.title}</h2>
    <p>{proposal.description ?? "No description."}</p>
    <dl className="proposal-detail__facts">
      <dt>Lifecycle</dt><dd><strong>{state}</strong>{lifecycleReason(state) ? ` · ${lifecycleReason(state)}` : ""}</dd>
      <dt>Author</dt><dd>{proposal.authorUserId}</dd>
      <dt>Submitted</dt><dd>{new Date(proposal.submittedAt).toLocaleString()}</dd>
      {proposal.supersedes ? <><dt>Supersedes</dt><dd><button type="button" onClick={() => onOpenProposal?.(proposal.supersedes!.id)}>{proposal.supersedes.title}</button></dd></> : null}
      {proposal.supersededBy ? <><dt>Succeeded by</dt><dd><button type="button" onClick={() => onOpenProposal?.(proposal.supersededBy!.id)}>{proposal.supersededBy.title}</button></dd></> : null}
    </dl>
     {reviseCapability?.allowed && proposal.revisionContextId && onRevise ? <button type="button" onClick={() => onRevise(proposal.revisionContextId!, proposal.id, proposal.resources[0]?.sourceResourceId ?? null)}>Revise proposal</button> : reviseCapability && !reviseCapability.allowed ? <p role="status">Revise unavailable: {capabilityMessage(reviseCapability.reason)}</p> : null}
    {withdrawCapability?.allowed ? <button type="button" onClick={() => setWithdrawOpen(true)}>Withdraw proposal</button> : withdrawCapability && !withdrawCapability.allowed && state === "OPEN" ? <p role="status">Withdraw unavailable: {capabilityMessage(withdrawCapability.reason)}</p> : null}
    {withdrawOpen ? <section role="dialog" aria-label="Withdraw proposal confirmation"><h3>Withdraw proposal?</h3><p>The proposal will remain in history, reviews will be preserved, SHARED will not change, and this proposal can no longer be reviewed or promoted.</p><label>Withdrawal reason <textarea value={withdrawReason} onChange={(event) => setWithdrawReason(event.target.value)} /></label><button type="button" onClick={() => setWithdrawOpen(false)}>Cancel</button><button type="button" onClick={() => void withdraw()}>Withdraw proposal</button></section> : null}
     <section className="proposal-detail__changes" aria-label="Changes"><h3>Impact</h3>{diff ? <p>{diff.impact.resourcesModified} resource{diff.impact.resourcesModified === 1 ? "" : "s"} modified · {diff.impact.resourcesAdded} added · {diff.impact.resourcesDeleted} deleted · {diff.impact.relationshipsChanged} relationships changed · {diff.impact.semanticIdentitiesChanged} semantic identities changed</p> : null}<h3>Changes</h3><h4>Resources</h4>{diff ? <DiffResourceList resources={diff.resources} selectedPath={selectedDiffPath} onSelect={setSelectedDiffPath} /> : <ChangeList items={changes.resources} />}<h4>Relationships</h4>{diff ? <DiffEntityList items={diff.relationships} /> : <ChangeList items={changes.relationships} />}<h4>Semantic identities</h4>{diff ? <DiffEntityList items={diff.semanticIdentities} /> : <ChangeList items={changes.semantic} />}</section>
     {diff && selectedDiffPath ? <ProposalResourceComparison resource={diff.resources.find((entry) => entry.path === selectedDiffPath) ?? null} /> : null}
    <section aria-label="Base status"><h3>Base status</h3><p>{proposal.staleBase ? "Stale: SHARED has changed since submission." : "Current: proposal base matches SHARED."}</p></section>
    <section aria-label="Proposal promotion"><h3>Promotion preview</h3><p>Promotion is a separate explicit operation and is the only action that can change SHARED.</p>{previewCapability?.allowed ? <button type="button" onClick={() => void previewPromotion()}>Preview promotion</button> : <p>Preview unavailable: {capabilityMessage(previewCapability?.reason)}</p>}{promotion && <><p>{promotion.eligible ? "Ready to promote" : "Promotion blocked"} · review {promotion.reviewStatus}</p>{promotion.blockers.length > 0 ? <><h4>Why it is blocked</h4><ul>{promotion.blockers.map((blocker) => <li key={`${blocker.code}-${blocker.message}`}><strong>{blocker.code.replaceAll("_", " ")}</strong>: {blocker.message}</li>)}</ul></> : null}{promotion.eligible && promoteCapability?.allowed ? <button type="button" onClick={() => void promote()}>Promote to SHARED</button> : promotion.eligible && promoteCapability ? <p>{capabilityMessage(promoteCapability.reason)}</p> : null}</>}</section>
    <section aria-label="Proposal review"><h3>Review evidence</h3><p>{reviews?.status ?? "none"} · {reviews?.approvals ?? 0} approvals · {reviews?.changesRequested ?? 0} changes requested</p><ul>{reviews?.reviews.map((review) => <li key={review.id}><strong>{review.decision === "APPROVE" ? "Approved" : "Changes requested"}</strong> by {review.reviewerDisplayName ?? review.reviewerUserId} on {new Date(review.createdAt).toLocaleString()}{review.summary ? `: ${review.summary}` : ""}</li>)}</ul>{!reviewLocked && reviewCapability?.allowed ? <fieldset><legend>Record review decision</legend><label><input type="radio" checked={decision === "APPROVE"} onChange={() => setDecision("APPROVE")} /> Approve</label><label><input type="radio" checked={decision === "REQUEST_CHANGES"} onChange={() => setDecision("REQUEST_CHANGES")} /> Request changes</label><textarea value={summary} onChange={(event) => setSummary(event.target.value)} placeholder="Review summary (recommended)" maxLength={4000} /><button type="button" onClick={() => void submitReview()}>Record {decision === "APPROVE" ? "approval" : "change request"}</button><p>Approval does not promote the proposal and does not modify SHARED.</p></fieldset> : !reviewLocked && reviewCapability ? <p role="status">Review unavailable: {capabilityMessage(reviewCapability.reason)}</p> : null}</section>
    {state === "PROMOTED" && onOpenShared ? <button type="button" onClick={onOpenShared}>Open resulting SHARED knowledge</button> : null}
    <details className="proposal-detail__technical"><summary>Technical details</summary><dl><dt>Base SHARED revision</dt><dd>{proposal.baseSharedRevision}</dd><dt>Current SHARED revision</dt><dd>{proposal.currentSharedRevision ?? "Unknown"}</dd><dt>Resources in snapshot</dt><dd>{proposal.resources.map((resource) => `${resource.path} (r${resource.sourceRevision})`).join(", ")}</dd></dl></details>
    {error ? <p role="alert">{error}</p> : null}
  </section>;
}

function capabilityMessage(reason?: string): string {
  switch (reason) {
    case "self_review": return "You cannot approve your own proposal.";
    case "proposal_not_eligible": return "This proposal is no longer eligible for this action.";
    case "not_owner": return "Only the proposal author can do this.";
    case "review_required": return "Review is required before promotion.";
    case "completion_pending": return "Promotion is currently completing.";
    case "promotion_in_progress": return "Promotion is currently completing.";
    case "forbidden": return "You do not have permission for this action.";
    default: return "The server does not currently allow this action.";
  }
}

function ChangeList({ items }: { items: Array<{ operation: string; label: string }> }) {
  return items.length === 0 ? <p>No reported changes.</p> : <ul>{items.map((item, index) => <li key={`${item.operation}-${item.label}-${index}`}><strong>{operationSymbol[item.operation] ?? ""} {item.operation}</strong> {item.label}</li>)}</ul>;
}

function DiffResourceList({ resources, selectedPath, onSelect }: { resources: ServerArchitecturalProposalDiffResource[]; selectedPath: string | null; onSelect: (path: string) => void }) {
  return resources.length === 0 ? <p>No resource changes.</p> : <ul>{resources.map((resource) => <li key={resource.path}><button type="button" aria-pressed={selectedPath === resource.path} onClick={() => onSelect(resource.path)}><strong>{resource.operation}</strong> {resource.path}</button></li>)}</ul>;
}

function DiffEntityList({ items }: { items: Array<{ operation: string; label: string }> }) {
  return items.length === 0 ? <p>No changes.</p> : <ul>{items.map((item) => <li key={`${item.operation}-${item.label}`}><strong>{item.operation}</strong> {item.label}</li>)}</ul>;
}

function ProposalResourceComparison({ resource }: { resource: ServerArchitecturalProposalDiffResource | null }) {
  if (!resource) return null;
  const representation = resourceRepresentationOfType(resource.type);
  return <section className="proposal-detail__comparison" aria-label={`Comparison for ${resource.path}`}><h3>{resource.operation} {resource.path}</h3>{representation === "markdown" ? <SourceDiff resource={resource} /> : <div className="proposal-detail__comparison-panes"><section><h4>BASE</h4>{representation === "event-flow" ? <EventFlowPreview source={resource.baseContent} reviewChanges={resource.content.changes} reviewMode reviewSide="base" /> : <Preview source={resource.baseContent} reviewChanges={resource.content.changes} reviewMode reviewSide="base" />}</section><section><h4>PROPOSED</h4>{representation === "event-flow" ? <EventFlowPreview source={resource.proposedContent} reviewChanges={resource.content.changes} reviewMode reviewSide="proposed" /> : <Preview source={resource.proposedContent} reviewChanges={resource.content.changes} reviewMode reviewSide="proposed" />}</section></div>}<details><summary>Technical source diff</summary><SourceDiff resource={resource} /></details></section>;
}

function SourceDiff({ resource }: { resource: ServerArchitecturalProposalDiffResource }) {
  return resource.source.changed ? <div className="proposal-detail__source-diff">{resource.source.hunks.map((hunk, index) => <div key={`${hunk.oldStart}-${hunk.newStart}-${index}`}><div>@@ {hunk.oldStart} / {hunk.newStart} @@</div>{hunk.oldLines.map((line, lineIndex) => <div className="proposal-review__line proposal-review__line--removed" key={`old-${lineIndex}`}>- {line}</div>)}{hunk.newLines.map((line, lineIndex) => <div className="proposal-review__line proposal-review__line--added" key={`new-${lineIndex}`}>+ {line}</div>)}</div>)} </div> : <p>No textual changes.</p>;
}
