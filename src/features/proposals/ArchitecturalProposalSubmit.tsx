import { useEffect, useState } from "react";
import type { ServerApiClient, ServerResource } from "../../workspace/server/api-client";

export function ArchitecturalProposalSubmit({ client, projectId, contextId, onDone, onCancel }: { client: ServerApiClient; projectId: string; contextId: string; onDone: () => void; onCancel: () => void }) {
  const [resources, setResources] = useState<ServerResource[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  useEffect(() => { void client.listResources(projectId, contextId).then(setResources).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "Private resources could not be loaded.")); }, [client, projectId, contextId]);
  const submit = async () => {
    setSubmitting(true); setError(null);
    try { await client.submitArchitecturalProposal(projectId, { sourcePrivateContextId: contextId, resourceIds: selected, title, ...(description ? { description } : {}) }); onDone(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "The proposal could not be submitted."); }
    finally { setSubmitting(false); }
  };
  return <section className="proposal-submit" aria-label="Submit architectural proposal">
    <button type="button" onClick={onCancel}>Cancel</button><h2>Submit for team review</h2>
    <p>Selected resources become an immutable, team-visible Proposal. MY WORK remains private and SHARED is unchanged.</p>
    <label>Title<input value={title} onChange={(event) => setTitle(event.target.value)} /></label>
    <label>Description<textarea value={description} onChange={(event) => setDescription(event.target.value)} /></label>
    <h3>Resources and dependency closure</h3>
    <ul>{resources.map((resource) => <li key={resource.id}><label><input type="checkbox" checked={selected.includes(resource.id)} onChange={(event) => setSelected((current) => event.target.checked ? [...current, resource.id] : current.filter((id) => id !== resource.id))} /> {resource.path} (revision {resource.revision})</label></li>)}</ul>
    {error ? <p role="alert">{error}</p> : null}
    <button type="button" disabled={submitting || !title.trim() || selected.length === 0} onClick={() => void submit()}>Confirm submission</button>
  </section>;
}
