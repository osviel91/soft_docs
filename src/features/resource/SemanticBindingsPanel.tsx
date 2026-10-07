import { useEffect, useState } from "react";
import type { EntityAnchor, IndexedEntity, SemanticBinding } from "../../domain/workspace/semantic-binding";
import { entityAnchorKey } from "../../domain/workspace/semantic-binding";
import type { ServerApiClient, ServerResource } from "../../workspace/server/api-client";

type EntityResource = { id: string; path: string; type: string };

export function SemanticBindingsPanel({ client, projectId, contextId, entities, resources, selectedAnchor, writable, onOpenEntity }: {
  client: ServerApiClient;
  projectId: string;
  contextId: string | null;
  entities: IndexedEntity[];
  resources: EntityResource[];
  selectedAnchor: EntityAnchor | null;
  writable: boolean;
  onOpenEntity: (anchor: EntityAnchor) => void;
}) {
  const [bindings, setBindings] = useState<SemanticBinding[]>([]);
  const [evidenceResources, setEvidenceResources] = useState<ServerResource[]>([]);
  const [endAnchorKey, setEndAnchorKey] = useState("");
  const [rationale, setRationale] = useState("");
  const [reference, setReference] = useState("");
  const [evidenceDescription, setEvidenceDescription] = useState("");
  const [evidenceKind, setEvidenceKind] = useState<"external" | "internal">("external");
  const [evidenceResourceId, setEvidenceResourceId] = useState("");
  const [editing, setEditing] = useState<SemanticBinding | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = async () => setBindings(await client.listSemanticBindings(projectId, contextId));
  useEffect(() => {
    let active = true;
    void Promise.all([client.listSemanticBindings(projectId, contextId), client.listResources(projectId), ...(contextId ? [client.listResources(projectId, contextId)] : [])]).then(([value, shared, privateResources = []]) => { if (active) { setBindings(value); setEvidenceResources([...shared, ...privateResources]); } }).catch(reason => { if (active) setError(reason instanceof Error ? reason.message : "Bindings could not be loaded."); });
    return () => { active = false; };
  }, [client, contextId, projectId]);

  const nameOf = (anchor: EntityAnchor) => entities.find(entity => entityAnchorKey(entity.anchor) === entityAnchorKey(anchor))?.name;
  const resourceOf = (anchor: EntityAnchor) => resources.find(resource => resource.id === anchor.resourceId);
  const endpointLabel = (anchor: EntityAnchor) => {
    const resource = resourceOf(anchor);
    const entityName = nameOf(anchor);
    const identity = anchor.identity.kind === "local-id" ? anchor.identity.value : `${anchor.identity.tableId}.${anchor.identity.name}`;
    return `${anchor.representation} ${anchor.entityKind} ${entityName ?? identity} · ${identity} · ${resource?.path ?? anchor.resourceId}`;
  };
  const endpointState = (anchor: EntityAnchor) => nameOf(anchor) === undefined ? "unresolved" : "resolved";
  const forEntity = selectedAnchor
    ? bindings.filter(binding => entityAnchorKey(binding.left) === entityAnchorKey(selectedAnchor) || entityAnchorKey(binding.right) === entityAnchorKey(selectedAnchor))
    : [];
  const possibleTargets = entities.filter(entity => selectedAnchor && entity.anchor.resourceId !== selectedAnchor.resourceId && entityAnchorKey(entity.anchor) !== entityAnchorKey(selectedAnchor));

  const resetEditor = () => { setEditing(null); setEndAnchorKey(""); setRationale(""); setReference(""); setEvidenceDescription(""); setEvidenceKind("external"); setEvidenceResourceId(""); };
  const edit = (binding: SemanticBinding) => {
    const other = selectedAnchor && entityAnchorKey(binding.left) === entityAnchorKey(selectedAnchor) ? binding.right : binding.left;
    setEditing(binding); setEndAnchorKey(entityAnchorKey(other)); setRationale(binding.evidence.rationale);
    const item = binding.evidence.items[0];
    setEvidenceKind(item?.kind === "internal" ? "internal" : "external");
    setEvidenceResourceId(item?.kind === "internal" ? item.resourceId : "");
    setReference(item?.kind === "external" ? item.reference : "");
    setEvidenceDescription(item?.kind === "external" ? item.description : "");
  };
  const save = async () => {
    if (!contextId || !selectedAnchor) return;
    const endpoint = entities.find(entity => entityAnchorKey(entity.anchor) === endAnchorKey)?.anchor;
    const evidenceResource = evidenceResources.find(resource => resource.id === evidenceResourceId);
    if (!endpoint || !rationale.trim() || (evidenceKind === "internal" ? !evidenceResource : !reference.trim() || !evidenceDescription.trim())) {
      setError("Choose an exact indexed endpoint and provide rationale plus Evidence."); return;
    }
    const [left, right] = editing && entityAnchorKey(editing.right) === entityAnchorKey(selectedAnchor)
      ? [endpoint, selectedAnchor]
      : [selectedAnchor, endpoint];
    setBusy(true); setError(null);
    try {
      const value = {
        ...(editing ? editing : { id: crypto.randomUUID() }),
        left, right, relation: "represents-in" as const,
        evidence: { version: 1 as const, rationale: rationale.trim(), items: [evidenceKind === "internal"
          ? { kind: "internal" as const, resourceId: evidenceResource!.id, revision: evidenceResource!.revision }
          : { kind: "external" as const, reference: reference.trim(), description: evidenceDescription.trim() }] },
      };
      if (editing) await client.updateSemanticBinding(projectId, contextId, { ...editing, left, right, relation: value.relation, evidence: value.evidence }, editing.revision);
      else await client.createSemanticBinding(projectId, contextId, { id: value.id, left, right, relation: value.relation, evidence: value.evidence });
      await reload(); resetEditor();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Binding could not be saved."); }
    finally { setBusy(false); }
  };
  const remove = async (binding: SemanticBinding) => {
    if (!contextId) return;
    setBusy(true); setError(null);
    try { await client.removeSemanticBinding(projectId, contextId, binding.id, binding.revision); await reload(); if (editing?.id === binding.id) resetEditor(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Binding could not be removed."); }
    finally { setBusy(false); }
  };

  return <section className="semantic-bindings" aria-label="Semantic Bindings" data-testid="semantic-bindings" data-context-id={contextId ?? "SHARED"} data-writable={writable}>
    <h3>Explicit relationships</h3>
    {!selectedAnchor ? <p>Select a Conceptual or Database entity to inspect explicit bindings. Similar names do not establish a relationship.</p> : <>
      <p><strong>Selected:</strong> {endpointLabel(selectedAnchor)}</p>
      {forEntity.length === 0 ? <p>No explicit bindings for this entity.</p> : <ul>{forEntity.map(binding => {
        const endpoint = entityAnchorKey(binding.left) === entityAnchorKey(selectedAnchor) ? binding.right : binding.left;
        const state = endpointState(binding.left) === "resolved" && endpointState(binding.right) === "resolved" ? "resolved" : "unresolved";
        return <li key={binding.id} data-testid={`semantic-binding-${binding.id}`}>
          <p><strong>{binding.relation}</strong> · {state}</p>
          <p>{endpointLabel(endpoint)}</p>
          {state === "resolved" ? <button type="button" onClick={() => onOpenEntity(endpoint)}>Open related entity</button> : <p role="status">Binding exists but endpoint is unresolved. This historical binding was not repaired by name.</p>}
          <p>Evidence: {binding.evidence.rationale}; {binding.evidence.items.map(item => item.kind === "external" ? `${item.description} (${item.reference})` : item.kind === "internal" ? `Internal evidence, ${evidenceResources.find(resource => resource.id === item.resourceId)?.path ?? item.resourceId}, revision ${item.revision}` : "Evidence unavailable").join("; ")}</p>
          <p>Provenance: {binding.provenance.contextId ? `MY WORK ${binding.provenance.contextId}` : "SHARED"}; author {binding.provenance.authorId}; {binding.provenance.createdAt}</p>
          {writable ? <><button type="button" onClick={() => edit(binding)}>Edit</button><button type="button" disabled={busy} onClick={() => void remove(binding)}>Remove</button></> : null}
        </li>;
      })}</ul>}
      {writable ? <fieldset>
        <legend>{editing ? "Edit explicit binding" : "Create explicit binding"}</legend>
        <label>Exact indexed endpoint<select aria-label="Exact indexed endpoint" value={endAnchorKey} onChange={event => setEndAnchorKey(event.target.value)}><option value="">Select an entity</option>{(editing ? entities.filter(entity => entityAnchorKey(entity.anchor) !== entityAnchorKey(selectedAnchor)) : possibleTargets).map(entity => <option key={entityAnchorKey(entity.anchor)} value={entityAnchorKey(entity.anchor)}>{entity.anchor.representation} {entity.anchor.entityKind}: {entity.name} · {entity.anchor.identity.kind === "local-id" ? entity.anchor.identity.value : `${entity.anchor.identity.tableId}.${entity.anchor.identity.name}`} · {resourceOf(entity.anchor)?.path ?? entity.anchor.resourceId}</option>)}</select></label>
        <p>Names help locate entities only; selecting an endpoint does not establish Evidence or infer a relationship.</p>
        <label>Relation kind<input value="represents-in" readOnly /></label>
        <label>Evidence rationale<textarea value={rationale} onChange={event => setRationale(event.target.value)} /></label>
        <label>Evidence kind<select aria-label="Evidence kind" value={evidenceKind} onChange={event => setEvidenceKind(event.target.value as "external" | "internal")}><option value="external">External reference</option><option value="internal">Internal resource</option></select></label>
        {evidenceKind === "internal" ? <label>Evidence resource<select aria-label="Evidence resource" value={evidenceResourceId} onChange={event => setEvidenceResourceId(event.target.value)}><option value="">Select a resource</option>{evidenceResources.map(resource => <option key={resource.id} value={resource.id}>{resource.path} · revision {resource.revision}</option>)}</select></label> : <><label>Evidence reference<input value={reference} onChange={event => setReference(event.target.value)} /></label><label>Evidence description<input value={evidenceDescription} onChange={event => setEvidenceDescription(event.target.value)} /></label></>}
        <button type="button" disabled={busy || !endAnchorKey} onClick={() => void save()}>{editing ? "Save binding" : "Create binding"}</button>
        {editing ? <button type="button" onClick={resetEditor}>Cancel edit</button> : null}
      </fieldset> : null}
    </>}
    {error ? <p role="alert">{error}</p> : null}
  </section>;
}
