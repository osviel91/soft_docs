import { useEffect, useRef, useState } from "react";
import type { ServerApiClient, ServerResource } from "../../workspace/server/api-client";
import type { SemanticBinding } from "../../domain/workspace/semantic-binding";

export function ArchitecturalProposalSubmit({ client, projectId, contextId, revisionProposalId, revisionProposalTitle, initialTitle = "", initialDescription = "", initialResourceIds = [], onDone, onCancel }: { client: ServerApiClient; projectId: string; contextId: string; revisionProposalId?: string | null; revisionProposalTitle?: string; initialTitle?: string; initialDescription?: string; initialResourceIds?: string[]; onDone: (proposalId: string) => void | Promise<void>; onCancel: () => void }) {
  const [resources, setResources] = useState<ServerResource[]>([]);
  const [bindings, setBindings] = useState<SemanticBinding[]>([]);
  const initialResourceIdsRef = useRef(initialResourceIds);
  const [selected, setSelected] = useState<string[]>(initialResourceIds);
  const [title, setTitle] = useState(initialTitle);
  const [description, setDescription] = useState(initialDescription);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [revisionConfirmOpen, setRevisionConfirmOpen] = useState(false);
   const [selectedBindings, setSelectedBindings] = useState<string[]>([]);
   useEffect(() => { let current = true; void Promise.all([client.listResources(projectId, contextId), client.listSemanticBindings(projectId, contextId)]).then(([next, nextBindings]) => { if (!current) return; setResources(next); setBindings(nextBindings); setSelected((selectedNow) => selectedNow.length > 0 ? selectedNow : initialResourceIdsRef.current.filter((id) => next.some((resource) => resource.id === id))); }).catch((reason: unknown) => { if (current) setError(reason instanceof Error ? reason.message : "Private resources could not be loaded."); }); return () => { current = false; }; }, [client, projectId, contextId]);
  const submit = async () => {
    setSubmitting(true); setError(null);
     try {
       const semanticBindings = bindings.filter(binding => selectedBindings.includes(binding.id)).map(binding => binding.provenance.contextId === contextId
         ? { bindingId: binding.id, operation: "ADD" as const, sourceRevision: binding.revision }
         : { bindingId: binding.id, operation: "REMOVE" as const, expectedRevision: binding.revision, baseFingerprint: JSON.stringify(binding) });
       const input = { sourcePrivateContextId: contextId, resourceIds: selected, ...(semanticBindings.length ? { semanticBindings } : {}), title, ...(description ? { description } : {}) };
       const proposal = revisionProposalId
         ? await client.reviseArchitecturalProposal(projectId, revisionProposalId, input)
         : await client.submitArchitecturalProposal(projectId, input);
        await onDone(proposal.id);
     }
    catch (reason) { setError(reason instanceof Error ? reason.message : "The proposal could not be submitted."); }
    finally { setSubmitting(false); }
  };
    return <section className="proposal-submit governance-card" role="dialog" aria-modal="false" aria-label="Submit architectural proposal">
      <button type="button" className="button button--ghost button--small" onClick={onCancel}>{revisionProposalId ? "Back to editing" : "Back to MY WORK"}</button><p className="governance-eyebrow">MY WORK to PROPOSAL</p><h2>{revisionProposalId ? "Review and submit revision" : "Submit for review"}</h2>
     {revisionProposalId ? <p role="status">Revising <strong>{revisionProposalTitle ?? revisionProposalId}</strong>. The source proposal remains unchanged until submission.</p> : null}
     <p>{revisionProposalId ? "Editing happens in MY WORK. This will create a new immutable proposal, supersede the current proposal, preserve its reviews on the old snapshot, and leave SHARED unchanged." : "Choose the private resources to include. The submission becomes an immutable, non-authoritative proposal."}</p>
    <label>Proposal title<input aria-label="Proposal title" value={title} onChange={(event) => setTitle(event.target.value)} /></label>
    <label>Intention and review context<textarea aria-label="Proposal description" value={description} onChange={(event) => setDescription(event.target.value)} /></label>
    <h3>Included resources</h3>
     <ul className="proposal-submit__resources">{resources.map((resource) => <li key={resource.id}><label><input type="checkbox" checked={selected.includes(resource.id)} onChange={(event) => setSelected((current) => event.target.checked ? [...current, resource.id] : current.filter((id) => id !== resource.id))} /> <span>{resource.path}</span><small>Operation will be determined by the governed SHARED base.</small></label></li>)}</ul>
     <h3>Semantic Bindings</h3>
     {bindings.filter(binding => binding.provenance.contextId === contextId || binding.provenance.contextId === undefined).length === 0 ? <p>No binding operations available.</p> : <ul>{bindings.filter(binding => binding.provenance.contextId === contextId || binding.provenance.contextId === undefined).map(binding => <li key={binding.id}><label><input type="checkbox" checked={selectedBindings.includes(binding.id)} onChange={event => setSelectedBindings(current => event.target.checked ? [...current, binding.id] : current.filter(id => id !== binding.id))} /> {binding.provenance.contextId === contextId ? "ADD" : "REMOVE"} · {binding.left.representation} {binding.left.entityKind} {binding.left.identity.kind === "local-id" ? binding.left.identity.value : binding.left.identity.name} → {binding.right.representation} {binding.right.entityKind} {binding.right.identity.kind === "local-id" ? binding.right.identity.value : binding.right.identity.name} ({binding.relation})</label><p>Evidence: {binding.evidence.rationale}</p></li>)}</ul>}
    <p className="governance-note"><strong>Before you submit:</strong> submitting creates a non-authoritative proposal. SHARED is not modified.</p>
    {error ? <p role="alert">{error}</p> : null}
      <button type="button" disabled={submitting || !title.trim() || (selected.length === 0 && selectedBindings.length === 0)} onClick={() => revisionProposalId ? setRevisionConfirmOpen(true) : void submit()}>{revisionProposalId ? "Submit revision" : "Submit proposal for review"}</button>
     {revisionConfirmOpen ? <section role="dialog" aria-label="Confirm proposal revision"><h3>Create revised proposal?</h3><p>A new immutable proposal will be created. The current proposal will become SUPERSEDED, its reviews remain on the old snapshot, the new proposal starts with zero reviews, and SHARED will not change.</p><button type="button" onClick={() => setRevisionConfirmOpen(false)}>Cancel</button><button type="button" onClick={() => { setRevisionConfirmOpen(false); void submit(); }}>Confirm revision</button></section> : null}
  </section>;
}
