import { useEffect, useState } from "react";
import type { ServerApiClient, ServerResource } from "../../workspace/server/api-client";

export function ArchitecturalProposalSubmit({ client, projectId, contextId, revisionProposalId, revisionProposalTitle, onDone, onCancel }: { client: ServerApiClient; projectId: string; contextId: string; revisionProposalId?: string | null; revisionProposalTitle?: string; onDone: (proposalId: string) => void | Promise<void>; onCancel: () => void }) {
  const [resources, setResources] = useState<ServerResource[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [revisionConfirmOpen, setRevisionConfirmOpen] = useState(false);
  useEffect(() => { void client.listResources(projectId, contextId).then(setResources).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "Private resources could not be loaded.")); }, [client, projectId, contextId]);
  const submit = async () => {
    setSubmitting(true); setError(null);
     try {
       const input = { sourcePrivateContextId: contextId, resourceIds: selected, title, ...(description ? { description } : {}) };
       const proposal = revisionProposalId
         ? await client.reviseArchitecturalProposal(projectId, revisionProposalId, input)
         : await client.submitArchitecturalProposal(projectId, input);
        await onDone(proposal.id);
     }
    catch (reason) { setError(reason instanceof Error ? reason.message : "The proposal could not be submitted."); }
    finally { setSubmitting(false); }
  };
  return <section className="proposal-submit governance-card" aria-label="Submit architectural proposal">
     <button type="button" onClick={onCancel}>{revisionProposalId ? "Back to source proposal" : "Back to MY WORK"}</button><p className="governance-eyebrow">MY WORK to PROPOSAL</p><h2>{revisionProposalId ? "Submit revision" : "Submit for review"}</h2>
     {revisionProposalId ? <p role="status">Revising <strong>{revisionProposalTitle ?? revisionProposalId}</strong>. The source proposal remains unchanged until submission.</p> : null}
     <p>{revisionProposalId ? "Editing happens in MY WORK. This will create a new immutable proposal, supersede the current proposal, preserve its reviews on the old snapshot, and leave SHARED unchanged." : "Choose the private resources to include. The submission becomes an immutable, non-authoritative proposal."}</p>
    <label>Proposal title<input aria-label="Proposal title" value={title} onChange={(event) => setTitle(event.target.value)} /></label>
    <label>Intention and review context<textarea aria-label="Proposal description" value={description} onChange={(event) => setDescription(event.target.value)} /></label>
    <h3>Included resources</h3>
    <ul className="proposal-submit__resources">{resources.map((resource) => <li key={resource.id}><label><input type="checkbox" checked={selected.includes(resource.id)} onChange={(event) => setSelected((current) => event.target.checked ? [...current, resource.id] : current.filter((id) => id !== resource.id))} /> <span>{resource.path}</span><small>Operation will be determined by the governed SHARED base.</small></label></li>)}</ul>
    <p className="governance-note"><strong>Before you submit:</strong> submitting creates a non-authoritative proposal. SHARED is not modified.</p>
    {error ? <p role="alert">{error}</p> : null}
     <button type="button" disabled={submitting || !title.trim() || selected.length === 0} onClick={() => revisionProposalId ? setRevisionConfirmOpen(true) : void submit()}>{revisionProposalId ? "Submit revision" : "Submit proposal for review"}</button>
     {revisionConfirmOpen ? <section role="dialog" aria-label="Confirm proposal revision"><h3>Create revised proposal?</h3><p>A new immutable proposal will be created. The current proposal will become SUPERSEDED, its reviews remain on the old snapshot, the new proposal starts with zero reviews, and SHARED will not change.</p><button type="button" onClick={() => setRevisionConfirmOpen(false)}>Cancel</button><button type="button" onClick={() => { setRevisionConfirmOpen(false); void submit(); }}>Confirm revision</button></section> : null}
  </section>;
}
