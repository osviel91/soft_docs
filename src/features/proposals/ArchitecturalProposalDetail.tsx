import { useEffect, useRef, useState } from "react";
import type { ServerApiClient, ServerArchitecturalProposal, ServerProposalReviewSummary, ServerPromotionPreview } from "../../workspace/server/api-client";
import { operationSymbol, proposalChangeSummary } from "./proposal-change-summary";
import { lifecycleReason, proposalLifecycle, type ProposalLifecycleState } from "./proposal-lifecycle";
import Preview from "../preview/Preview";
import EventFlowPreview from "../preview/EventFlowPreview";
import MarkdownView from "../notes/MarkdownView";
import { resourceRepresentationOfType } from "../../domain/workspace/resource-id";
import { diffResources } from "../../domain/diff/resource-diff";
import type { ServerArchitecturalProposalDiff, ServerArchitecturalProposalDiffResource } from "../../workspace/server/api-client";

interface Props {
  client: ServerApiClient;
  projectId: string;
  proposalId: string;
  onBack: () => void;
  onChanged?: () => void | Promise<void>;
  onOpenShared?: () => void;
  onOpenProposal?: (proposalId: string) => void;
  onRevise?: (contextId: string, proposalId: string, resourceId: string | null, resources: Array<{ resourceId: string; path: string; type: ServerArchitecturalProposal["resources"][number]["type"]; content: string }>, title: string, description: string) => void;
  authorDisplayName?: string;
  selectedDiffPath?: string | null;
  onSelectDiff?: (path: string) => void;
  onDiffLoaded?: (diff: ServerArchitecturalProposalDiff) => void;
  onHideDetails?: () => void;
}

export type ComparisonMode = "unified" | "side-by-side" | "rendered" | "before" | "after" | "compare";

export function ArchitecturalProposalDetail({ client, projectId, proposalId, onBack, onChanged, onOpenShared, onOpenProposal, onRevise, authorDisplayName, selectedDiffPath: controlledPath, onSelectDiff, onDiffLoaded, onHideDetails }: Props) {
  const [proposal, setProposal] = useState<ServerArchitecturalProposal | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reviews, setReviews] = useState<ServerProposalReviewSummary | null>(null);
  const [summary, setSummary] = useState("");
  const [withdrawReason, setWithdrawReason] = useState("");
  const [withdrawOpen, setWithdrawOpen] = useState(false);
  const [promotion, setPromotion] = useState<ServerPromotionPreview | null>(null);
  const [activeDetailTab, setActiveDetailTab] = useState("review");
  const [diff, setDiff] = useState<ServerArchitecturalProposalDiff | null>(null);
  const [localSelectedDiffPath, setLocalSelectedDiffPath] = useState<string | null>(null);
  const selectedDiffPath = controlledPath === undefined ? localSelectedDiffPath : controlledPath;
  const controlledPathRef = useRef(controlledPath);
  controlledPathRef.current = controlledPath;

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
    void client.getArchitecturalProposalDiff(projectId, proposalId).then((value) => { if (!active) return; setDiff(value); if (controlledPathRef.current === undefined) setLocalSelectedDiffPath(value.resources[0]?.path ?? null); onDiffLoaded?.(value); }).catch(() => { if (active) setError("The proposal comparison could not be loaded."); });
    return () => { active = false; };
  }, [client, projectId, proposalId, onDiffLoaded]);

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

  const submitReview = async (decision: "APPROVE" | "REQUEST_CHANGES") => { try { await client.reviewArchitecturalProposal(projectId, proposalId, { decision, ...(summary.trim() ? { summary: summary.trim() } : {}) }); setSummary(""); setPromotion(null); await reload(); await onChanged?.(); } catch (reason) { setError(reason instanceof Error ? reason.message : "The review could not be submitted."); } };
  const previewPromotion = async () => { try { setPromotion(await client.previewArchitecturalProposalPromotion(projectId, proposalId)); } catch (reason) { setError(reason instanceof Error ? reason.message : "The promotion preview could not be loaded."); } };
  const promote = async () => { try { await client.promoteArchitecturalProposal(projectId, proposalId); await reload(); setPromotion(await client.previewArchitecturalProposalPromotion(projectId, proposalId)); await onChanged?.(); } catch (reason) { setError(reason instanceof Error ? reason.message : "The proposal could not be promoted."); } };
  const withdraw = async () => { try { await client.withdrawArchitecturalProposal(projectId, proposalId, withdrawReason.trim()); setWithdrawOpen(false); setWithdrawReason(""); await reload(); await onChanged?.(); } catch (reason) { setError(reason instanceof Error ? reason.message : "The proposal could not be withdrawn."); } };
  const reviewSection = <section aria-label="Proposal review"><h3>Review state</h3><p>{reviews?.status ?? "none"} · {reviews?.approvals ?? 0} approvals · {reviews?.changesRequested ?? 0} change requests</p><ul>{reviews?.reviews.map((review) => <li key={review.id}><strong>{review.decision === "APPROVE" ? "Approved" : "Changes requested"}</strong> by {review.reviewerDisplayName ?? review.reviewerUserId} on {new Date(review.createdAt).toLocaleString()}{review.summary ? `: ${review.summary}` : ""}</li>)}</ul>{!reviewLocked && reviewCapability?.allowed ? <fieldset><legend>Decision</legend><label className="proposal-detail__review-summary">Review summary<textarea value={summary} onChange={(event) => setSummary(event.target.value)} placeholder="Add a review summary (optional)" maxLength={4000} /></label><div className="proposal-detail__decision-actions"><button type="button" onClick={() => void submitReview("REQUEST_CHANGES")}>Request changes</button><button type="button" className="button button--primary" onClick={() => void submitReview("APPROVE")}>Approve proposal</button></div><p>Approval records review evidence only. It does not promote the proposal or modify SHARED.</p></fieldset> : !reviewLocked && reviewCapability ? <p role="status">Review unavailable: {capabilityMessage(reviewCapability.reason)}</p> : null}</section>;

  return <section className="proposal-detail" aria-label="Architectural Proposal">
      <div className="proposal-detail__toolbar">{onHideDetails ? <button type="button" className="button button--ghost button--small" onClick={onHideDetails}>Hide proposal details</button> : null}</div>
     <p className="governance-eyebrow">PROPOSAL / DECISION</p>
     <h2>{proposal.title}</h2>
     <p className="proposal-detail__intent">{proposal.description ?? "No description."}</p>
     <dl className="proposal-detail__facts">
       <dt>Lifecycle</dt><dd><strong>{state}</strong>{lifecycleReason(state) ? ` · ${lifecycleReason(state)}` : ""}</dd>
       <dt>Author</dt><dd>{authorDisplayName ?? proposal.authorUserId}</dd>
      <dt>Submitted</dt><dd>{new Date(proposal.submittedAt).toLocaleString()}</dd>
      {proposal.supersedes ? <><dt>Supersedes</dt><dd><button type="button" onClick={() => onOpenProposal?.(proposal.supersedes!.id)}>{proposal.supersedes.title}</button></dd></> : null}
      {proposal.supersededBy ? <><dt>Succeeded by</dt><dd><button type="button" onClick={() => onOpenProposal?.(proposal.supersededBy!.id)}>{proposal.supersededBy.title}</button></dd></> : null}
    </dl>
      <div className="proposal-detail__actions" aria-label="Proposal actions">
        {reviseCapability?.allowed && proposal.revisionContextId && onRevise ? <button type="button" className="button button--ghost button--small" onClick={() => onRevise(proposal.revisionContextId!, proposal.id, proposal.resources.find((resource) => resource.path === selectedDiffPath)?.sourceResourceId ?? proposal.resources[0]?.sourceResourceId ?? null, proposal.resources.map(({ sourceResourceId, path, type, content }) => ({ resourceId: sourceResourceId, path, type, content })), proposal.title, proposal.description ?? "")}>Edit revision</button> : null}
        {withdrawCapability?.allowed ? <button type="button" className="button button--ghost button--small button--danger-text" onClick={() => setWithdrawOpen(true)}>Withdraw proposal</button> : null}
        {!reviewLocked && reviewCapability?.allowed ? <span className="proposal-detail__decision-hint">Independent review available below.</span> : null}
      </div>
     {withdrawOpen ? <section role="dialog" aria-label="Withdraw proposal confirmation"><h3>Withdraw proposal?</h3><p>The proposal will remain in history, reviews will be preserved, SHARED will not change, and this proposal can no longer be reviewed or promoted.</p><label>Withdrawal reason <textarea value={withdrawReason} onChange={(event) => setWithdrawReason(event.target.value)} /></label><button type="button" onClick={() => setWithdrawOpen(false)}>Cancel</button><button type="button" onClick={() => void withdraw()}>Withdraw proposal</button></section> : null}
      <nav className="proposal-detail__tabs" aria-label="Proposal details">{[["review", "Review"], ["impact", "Impact"], ["base", "Base status"], ["technical", "Technical details"]].map(([id, label]) => <button key={id} type="button" aria-pressed={activeDetailTab === id} onClick={() => setActiveDetailTab(id)}>{label}</button>)}</nav>
      {activeDetailTab === "review" ? reviewSection : null}
      {activeDetailTab === "impact" ? <section className="proposal-detail__changes" aria-label="Changes"><h3>Impact</h3>{diff ? <p data-testid="proposal-impact">{diff.impact.resourcesModified} modified · {diff.impact.resourcesAdded} added · {diff.impact.resourcesDeleted} removed · {diff.impact.relationshipsChanged} relationships changed · {diff.impact.semanticIdentitiesChanged} semantic identities affected</p> : null}<h3>Changes</h3><h4>Resources</h4>{diff ? <DiffResourceList resources={diff.resources} selectedPath={selectedDiffPath} onSelect={(path) => { onSelectDiff?.(path); if (controlledPath === undefined) setLocalSelectedDiffPath(path); }} /> : <ChangeList items={changes.resources} />}<h4>Relationships</h4>{diff ? <DiffEntityList items={diff.relationships} /> : <ChangeList items={changes.relationships} />}<h4>Semantic identities</h4>{diff ? <DiffEntityList items={diff.semanticIdentities} /> : <ChangeList items={changes.semantic} />}</section> : null}
     {activeDetailTab === "base" ? <section aria-label="Base status"><h3>Base status</h3><p>{proposal.staleBase ? "Stale: SHARED has changed since submission." : "Current: proposal base matches SHARED."}</p></section> : null}
     {!(["PROMOTED", "WITHDRAWN", "SUPERSEDED"] as string[]).includes(state) ? <section aria-label="Proposal promotion"><h3>Promotion preview</h3><p>Promotion is a separate explicit operation and is the only action that can change SHARED.</p>{previewCapability?.allowed ? <button type="button" onClick={() => void previewPromotion()}>Preview promotion</button> : <p>Preview unavailable: {capabilityMessage(previewCapability?.reason)}</p>}{promotion && <><p>{promotion.eligible ? "Ready to promote" : "Promotion blocked"} · review {promotion.reviewStatus}</p>{promotion.blockers.length > 0 ? <><h4>Why it is blocked</h4><ul>{promotion.blockers.map((blocker) => <li key={`${blocker.code}-${blocker.message}`}><strong>{blocker.code.replaceAll("_", " ")}</strong>: {blocker.message}</li>)}</ul></> : null}{promotion.eligible && promoteCapability?.allowed ? <button type="button" onClick={() => void promote()}>Promote to SHARED</button> : promotion.eligible && promoteCapability ? <p>{capabilityMessage(promoteCapability.reason)}</p> : null}</>}</section> : null}
     {activeDetailTab === "base" && state === "PROMOTED" && onOpenShared ? <button type="button" onClick={onOpenShared}>Open resulting SHARED knowledge</button> : null}
     {activeDetailTab === "technical" ? <details className="proposal-detail__technical" open><summary>Technical details</summary><dl><dt>Base SHARED revision</dt><dd>{proposal.baseSharedRevision}</dd><dt>Current SHARED revision</dt><dd>{proposal.currentSharedRevision ?? "Unknown"}</dd><dt>Resources in snapshot</dt><dd>{proposal.resources.map((resource) => `${resource.path} (r${resource.sourceRevision})`).join(", ")}</dd></dl></details> : null}
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

export function ProposalResourceComparison({ resource, mode, onModeChange, beforeLabel = "BASE", afterLabel = "PROPOSED", inspectorLabel = "CHANGE INSPECTOR", headingLabel }: { resource: ServerArchitecturalProposalDiffResource | null; mode: ComparisonMode; onModeChange: (mode: ComparisonMode) => void; beforeLabel?: string; afterLabel?: string; inspectorLabel?: string; headingLabel?: string }) {
  if (!resource) return null;
  const hasTextChanges = resource.baseContent !== resource.proposedContent;
  const source = resource.source.changed === hasTextChanges && (!hasTextChanges || resource.source.hunks.length > 0)
    ? resource.source
    : diffResources({ content: resource.baseContent, type: resource.type }, { content: resource.proposedContent, type: resource.type }).source;
  const comparedResource = source === resource.source ? resource : { ...resource, source };
  const representation = resourceRepresentationOfType(resource.type);
  const sourceOnly = representation === "conceptual" || representation === "database";
  const textMode = representation === "markdown" || sourceOnly;
  const activeMode = textMode && !["unified", "side-by-side", "rendered"].includes(mode) ? "unified" : !textMode && !["before", "after", "compare"].includes(mode) ? "compare" : mode;
  return <section className="proposal-inspector" aria-label={`Comparison for ${resource.path}`}><header className="proposal-inspector__header"><div><p className="governance-eyebrow">{inspectorLabel}</p><h3>{headingLabel ? `${headingLabel} ${resource.path}` : `${resource.operation} ${resource.path}`}</h3></div><nav aria-label="Comparison mode">{(textMode ? sourceOnly ? [["unified", "Unified"], ["side-by-side", "Side-by-side"]] : [["unified", "Unified"], ["side-by-side", "Side-by-side"], ["rendered", "Rendered"]] : [["before", "Before"], ["after", "After"], ["compare", "Compare"]]).map(([key, label]) => <button type="button" key={key} aria-pressed={activeMode === key} onClick={() => onModeChange(key as typeof activeMode)}>{label}</button>)}</nav></header>{textMode ? activeMode === "unified" ? <SourceDiff resource={comparedResource} /> : activeMode === "side-by-side" ? <SideBySideDiff resource={comparedResource} beforeLabel={beforeLabel} afterLabel={afterLabel} /> : sourceOnly ? <p>Visual comparison is not available for this source artifact yet.</p> : <div className="proposal-detail__comparison-panes"><section><h4>{beforeLabel}</h4><MarkdownView markdown={resource.baseContent} /></section><section><h4>{afterLabel}</h4><MarkdownView markdown={resource.proposedContent} /></section></div> : <div className="proposal-detail__comparison-panes">{activeMode !== "after" ? <section><h4>{beforeLabel}</h4>{representation === "event-flow" ? <EventFlowPreview source={resource.baseContent} reviewChanges={resource.content.changes} reviewMode reviewSide="base" /> : <Preview source={resource.baseContent} reviewChanges={resource.content.changes} reviewMode reviewSide="base" />}</section> : null}{activeMode !== "before" ? <section><h4>{afterLabel}</h4>{representation === "event-flow" ? <EventFlowPreview source={resource.proposedContent} reviewChanges={resource.content.changes} reviewMode reviewSide="proposed" /> : <Preview source={resource.proposedContent} reviewChanges={resource.content.changes} reviewMode reviewSide="proposed" />}</section> : null}</div>}<details><summary>Technical source diff</summary><SourceDiff resource={comparedResource} /></details></section>;
}

function SideBySideDiff({ resource, beforeLabel, afterLabel }: { resource: ServerArchitecturalProposalDiffResource; beforeLabel: string; afterLabel: string }) {
  if (resource.baseContent === resource.proposedContent) return <p>No textual changes.</p>;
  const oldLines = resource.baseContent.replace(/\r\n?/g, "\n").split("\n");
  const newLines = resource.proposedContent.replace(/\r\n?/g, "\n").split("\n");
  const rows = alignLines(oldLines, newLines, resource.source.hunks);
  return <div className="proposal-detail__side-by-side"><div><h4>{beforeLabel}</h4>{rows.map((row, index) => <div key={`old-${index}`} className={`proposal-review__line${row.changed ? " proposal-review__line--removed" : ""}`}><span>{row.oldNumber ?? ""}</span> {row.oldLine}</div>)}</div><div><h4>{afterLabel}</h4>{rows.map((row, index) => <div key={`new-${index}`} className={`proposal-review__line${row.changed ? " proposal-review__line--added" : ""}`}><span>{row.newNumber ?? ""}</span> {row.newLine}</div>)}</div></div>;
}

function alignLines(oldLines: string[], newLines: string[], hunks: ServerArchitecturalProposalDiffResource["source"]["hunks"]): Array<{ oldLine: string; newLine: string; oldNumber: number | null; newNumber: number | null; changed: boolean }> {
  const rows: Array<{ oldLine: string; newLine: string; oldNumber: number | null; newNumber: number | null; changed: boolean }> = [];
  let oldIndex = 0;
  let newIndex = 0;
  for (const hunk of hunks) {
    const oldStart = Math.max(oldIndex, hunk.oldStart - 1);
    const newStart = Math.max(newIndex, hunk.newStart - 1);
    while (oldIndex < oldStart && newIndex < newStart) {
      rows.push({ oldLine: oldLines[oldIndex], newLine: newLines[newIndex], oldNumber: oldIndex + 1, newNumber: newIndex + 1, changed: false });
      oldIndex += 1;
      newIndex += 1;
    }
    while (oldIndex < oldStart) {
      rows.push({ oldLine: oldLines[oldIndex], newLine: "", oldNumber: oldIndex + 1, newNumber: null, changed: true });
      oldIndex += 1;
    }
    while (newIndex < newStart) {
      rows.push({ oldLine: "", newLine: newLines[newIndex], oldNumber: null, newNumber: newIndex + 1, changed: true });
      newIndex += 1;
    }
    for (let index = 0; index < Math.max(hunk.oldLines.length, hunk.newLines.length); index += 1) {
      const oldLine = hunk.oldLines[index];
      const newLine = hunk.newLines[index];
      rows.push({ oldLine: oldLine ?? "", newLine: newLine ?? "", oldNumber: oldLine === undefined ? null : oldIndex + 1, newNumber: newLine === undefined ? null : newIndex + 1, changed: true });
      if (oldLine !== undefined) oldIndex += 1;
      if (newLine !== undefined) newIndex += 1;
    }
  }
  while (oldIndex < oldLines.length && newIndex < newLines.length && oldLines[oldIndex] === newLines[newIndex]) {
    rows.push({ oldLine: oldLines[oldIndex], newLine: newLines[newIndex], oldNumber: oldIndex + 1, newNumber: newIndex + 1, changed: false });
    oldIndex += 1;
    newIndex += 1;
  }
  while (oldIndex < oldLines.length) {
    rows.push({ oldLine: oldLines[oldIndex], newLine: "", oldNumber: oldIndex + 1, newNumber: null, changed: true });
    oldIndex += 1;
  }
  while (newIndex < newLines.length) {
    rows.push({ oldLine: "", newLine: newLines[newIndex], oldNumber: null, newNumber: newIndex + 1, changed: true });
    newIndex += 1;
  }
  return rows;
}

function SourceDiff({ resource }: { resource: ServerArchitecturalProposalDiffResource }) {
  return resource.source.changed ? <div className="proposal-detail__source-diff">{resource.source.hunks.map((hunk, index) => <div key={`${hunk.oldStart}-${hunk.newStart}-${index}`}><div>@@ {hunk.oldStart} / {hunk.newStart} @@</div>{hunk.oldLines.map((line, lineIndex) => <div className="proposal-review__line proposal-review__line--removed" key={`old-${lineIndex}`}>- {line}</div>)}{hunk.newLines.map((line, lineIndex) => <div className="proposal-review__line proposal-review__line--added" key={`new-${lineIndex}`}>+ {line}</div>)}</div>)} </div> : <p>No textual changes.</p>;
}
