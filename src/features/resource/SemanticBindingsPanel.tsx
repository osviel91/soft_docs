import { useEffect, useState } from "react";
import type { EntityAnchor, IndexedEntity, SemanticBinding } from "../../domain/workspace/semantic-binding";
import { entityAnchorKey } from "../../domain/workspace/semantic-binding";
import type { ServerApiClient, ServerResource } from "../../workspace/server/api-client";
import type { ServerCandidateAssessment, ServerSemanticCandidate } from "../../workspace/server/api-client";

type EntityResource = { id: string; path: string; type: string };

export function SemanticBindingsPanel({ client, projectId, contextId, entities, resources, resourceAliases, selectedAnchor, writable, onOpenEntity }: {
  client: ServerApiClient;
  projectId: string;
  contextId: string | null;
  entities: IndexedEntity[];
  resources: EntityResource[];
  resourceAliases: Map<string, string>;
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
  const [candidates, setCandidates] = useState<ServerSemanticCandidate[]>([]);
  const [assessments, setAssessments] = useState<ServerCandidateAssessment[]>([]);
  const [candidateCursor, setCandidateCursor] = useState<string | undefined>();
  const [nextCandidateCursor, setNextCandidateCursor] = useState<string | undefined>();
  const [candidateFilter, setCandidateFilter] = useState("ALL");
  const [assessmentRationales, setAssessmentRationales] = useState<Record<string, string>>({});
  const [assessmentEvidence, setAssessmentEvidence] = useState<Record<string, { reference: string; description: string }>>({});
  const [candidateBusy, setCandidateBusy] = useState(false);
  const [discoveryRefresh, setDiscoveryRefresh] = useState(0);

  const reload = async () => setBindings(await client.listSemanticBindings(projectId, contextId));
  useEffect(() => {
    let active = true;
    void Promise.all([client.listSemanticBindings(projectId, contextId), client.listResources(projectId), ...(contextId ? [client.listResources(projectId, contextId)] : [])]).then(([value, shared, privateResources = []]) => { if (active) { setBindings(value); setEvidenceResources([...shared, ...privateResources]); } }).catch(reason => { if (active) setError(reason instanceof Error ? reason.message : "Bindings could not be loaded."); });
    return () => { active = false; };
  }, [client, contextId, projectId]);

  useEffect(() => {
    let active = true;
    setCandidateBusy(true);
    void Promise.all([
      client.listSemanticCandidates(projectId, { contextId, limit: 50, ...(candidateCursor ? { cursor: candidateCursor } : {}) }),
      contextId ? client.listCandidateAssessments(projectId, contextId, { limit: 200 }) : Promise.resolve({ assessments: [], total: 0 }),
    ]).then(([page, reviewed]) => {
      if (active) { setCandidates(current => candidateCursor ? [...current, ...page.candidates] : page.candidates); setNextCandidateCursor(page.nextCursor); setAssessments(reviewed.assessments); }
    }).catch(reason => { if (active) setError(reason instanceof Error ? reason.message : "Candidates could not be loaded."); })
      .finally(() => { if (active) setCandidateBusy(false); });
    return () => { active = false; };
  }, [client, contextId, projectId, candidateCursor, discoveryRefresh]);

  const uiAnchorKey = (anchor: EntityAnchor) => entityAnchorKey({ ...anchor, resourceId: resourceAliases.get(anchor.resourceId) ?? anchor.resourceId });
  const serverAnchor = (anchor: EntityAnchor) => {
    const serverResourceId = [...resourceAliases].find(([, localId]) => localId === anchor.resourceId)?.[0];
    return serverResourceId ? { ...anchor, resourceId: serverResourceId } : anchor;
  };
  const nameOf = (anchor: EntityAnchor) => entities.find(entity => uiAnchorKey(entity.anchor) === uiAnchorKey(anchor))?.name;
  const resourceOf = (anchor: EntityAnchor) => resources.find(resource => resource.id === (resourceAliases.get(anchor.resourceId) ?? anchor.resourceId));
  const endpointLabel = (anchor: EntityAnchor) => {
    const resource = resourceOf(anchor);
    const entityName = nameOf(anchor);
    const identity = anchor.identity.kind === "local-id" ? anchor.identity.value : `${anchor.identity.tableId}.${anchor.identity.name}`;
    return `${anchor.representation} ${anchor.entityKind} ${entityName ?? identity} · ${identity} · ${resource?.path ?? anchor.resourceId}`;
  };
  const endpointState = (anchor: EntityAnchor) => nameOf(anchor) === undefined ? "unresolved" : "resolved";
  const forEntity = selectedAnchor
    ? bindings.filter(binding => uiAnchorKey(binding.left) === uiAnchorKey(selectedAnchor) || uiAnchorKey(binding.right) === uiAnchorKey(selectedAnchor))
    : [];
  const possibleTargets = entities.filter(entity => selectedAnchor && entity.anchor.resourceId !== selectedAnchor.resourceId && entityAnchorKey(entity.anchor) !== entityAnchorKey(selectedAnchor));

  const resetEditor = () => { setEditing(null); setEndAnchorKey(""); setRationale(""); setReference(""); setEvidenceDescription(""); setEvidenceKind("external"); setEvidenceResourceId(""); };
  const edit = (binding: SemanticBinding) => {
    const other = selectedAnchor && uiAnchorKey(binding.left) === uiAnchorKey(selectedAnchor) ? binding.right : binding.left;
    setEditing(binding); setEndAnchorKey(entityAnchorKey({ ...other, resourceId: resourceAliases.get(other.resourceId) ?? other.resourceId })); setRationale(binding.evidence.rationale);
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
    const [left, right] = editing && uiAnchorKey(editing.right) === uiAnchorKey(selectedAnchor)
      ? [endpoint, selectedAnchor]
      : [selectedAnchor, endpoint];
    setBusy(true); setError(null);
    try {
      const value = {
        ...(editing ? editing : { id: crypto.randomUUID() }),
        left: serverAnchor(left), right: serverAnchor(right), relation: "represents-in" as const,
        evidence: { version: 1 as const, rationale: rationale.trim(), items: [evidenceKind === "internal"
          ? { kind: "internal" as const, resourceId: evidenceResource!.id, revision: evidenceResource!.revision }
          : { kind: "external" as const, reference: reference.trim(), description: evidenceDescription.trim() }] },
      };
      if (editing) await client.updateSemanticBinding(projectId, contextId, { ...editing, left: value.left, right: value.right, relation: value.relation, evidence: value.evidence }, editing.revision);
      else await client.createSemanticBinding(projectId, contextId, { id: value.id, left: value.left, right: value.right, relation: value.relation, evidence: value.evidence });
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

  const reloadCandidates = () => { setCandidateCursor(undefined); setDiscoveryRefresh(value => value + 1); };
  const assessCandidate = async (candidate: ServerSemanticCandidate, decision: "NEEDS_EVIDENCE" | "REJECTED" | "READY_FOR_BINDING") => {
    if (!contextId) return;
    const rationaleValue = assessmentRationales[candidate.id]?.trim();
    const prior = assessments.find(item => item.candidateId === candidate.id);
    const ev = assessmentEvidence[candidate.id];
    if (!rationaleValue || (decision === "READY_FOR_BINDING" && (!ev?.reference.trim() || !ev.description.trim()))) {
      setError("Provide a rationale; READY also requires an explicit evidence reference and description."); return;
    }
    setCandidateBusy(true); setError(null);
    try {
      const evidence = decision === "READY_FOR_BINDING" ? { version: 1 as const, rationale: rationaleValue, items: [{ kind: "external" as const, reference: ev!.reference.trim(), description: ev!.description.trim() }] } : undefined;
      await client.assessSemanticCandidate(projectId, contextId, candidate.id, { decision, rationale: rationaleValue, fingerprint: candidate.fingerprint, ...(evidence ? { evidence } : {}), ...(prior ? { expectedRevision: prior.revision } : { expectedRevision: 0 }) });
      const refreshed = await client.listCandidateAssessments(projectId, contextId, { limit: 200 });
      setAssessments(refreshed.assessments);
    } catch (reason) { setError(`${reason instanceof Error ? reason.message : "Assessment failed."} Reload candidates and reassess; no data was overwritten.`); }
    finally { setCandidateBusy(false); }
  };

  const materialize = async (assessment: ServerCandidateAssessment) => {
    if (!contextId || assessment.status !== "CURRENT" || assessment.decision !== "READY_FOR_BINDING" || !assessment.evidence) return;
    const existing = bindings.find(binding => binding.status === "ACTIVE" && entityAnchorKey(binding.left) === entityAnchorKey(assessment.candidate.left) && entityAnchorKey(binding.right) === entityAnchorKey(assessment.candidate.right));
    if (existing) { setError("An exact active binding already exists; it is shown in Explicit relationships."); return; }
    if (!window.confirm(`Create explicit represents-in binding in MY WORK?\n\nConceptual: ${endpointLabel(assessment.candidate.left)}\nDatabase: ${endpointLabel(assessment.candidate.right)}\n\nEvidence: ${assessment.evidence.rationale}`)) return;
    setBusy(true); setError(null);
    try {
      await client.createSemanticBinding(projectId, contextId, { id: crypto.randomUUID(), left: assessment.candidate.left, right: assessment.candidate.right, relation: "represents-in", evidence: assessment.evidence });
      await reload(); reloadCandidates();
    } catch (reason) { setError(`${reason instanceof Error ? reason.message : "Binding could not be created."} Reload before retrying.`); }
    finally { setBusy(false); }
  };

  return <section className="semantic-bindings" aria-label="Semantic Bindings" data-testid="semantic-bindings" data-context-id={contextId ?? "SHARED"} data-writable={writable}>
    <h3>Explicit relationships</h3>
    {!selectedAnchor ? <p>Select a Conceptual or Database entity to inspect explicit bindings. Similar names do not establish a relationship.</p> : <>
      <p><strong>Selected:</strong> {endpointLabel(selectedAnchor)}</p>
      {forEntity.length === 0 ? <p>No explicit bindings for this entity.</p> : <ul>{forEntity.map(binding => {
        const endpoint = uiAnchorKey(binding.left) === uiAnchorKey(selectedAnchor) ? binding.right : binding.left;
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
    <section aria-label="Suggested correspondences" data-testid="semantic-candidates">
      <h3>Suggested correspondences</h3>
      <p>Candidates are unconfirmed suggestions, not bindings or Evidence. Ranking is ordinal, not a probability. Scope: {contextId ? "SHARED + MY WORK (MY WORK is editable)" : "SHARED (read-only)"}.</p>
      <label>Filter candidates<select aria-label="Filter candidates" value={candidateFilter} onChange={event => setCandidateFilter(event.target.value)}><option value="ALL">All</option><option value="UNASSESSED">Not reviewed</option><option value="NEEDS_EVIDENCE">Needs evidence</option><option value="REJECTED">Rejected</option><option value="READY_FOR_BINDING">Ready for binding</option><option value="STALE">Stale assessment</option></select></label>
      {candidateBusy ? <p role="status">Loading candidates…</p> : null}
      {!candidateBusy && candidates.length === 0 ? <p>No unbound name-matched candidates in this context. This does not imply that no correspondence exists.</p> : null}
      <ul>{candidates.filter(candidate => {
        const assessment = assessments.find(item => item.candidateId === candidate.id);
        return candidateFilter === "ALL" || (candidateFilter === "UNASSESSED" ? !assessment : candidateFilter === "STALE" ? assessment?.status === "STALE" : assessment?.decision === candidateFilter && assessment.status === "CURRENT");
      }).map(candidate => {
        const assessment = assessments.find(item => item.candidateId === candidate.id);
        return <li key={candidate.id} data-testid={`candidate-${candidate.id}`}>
          <p><strong>Candidate · not a binding</strong> · {assessment ? `${assessment.decision} · ${assessment.status}` : "Not reviewed"}</p>
          <p>Conceptual {candidate.leftType}: {candidate.leftName} · {candidate.leftPath} → Database {candidate.rightType}: {candidate.rightName} · {candidate.rightPath} · represents-in</p>
          <button type="button" onClick={() => onOpenEntity(candidate.left)}>Open Conceptual entity</button> <button type="button" onClick={() => onOpenEntity(candidate.right)}>Open Database entity</button>
          <p>Ranking {candidate.ranking}; not a probability. {candidate.ambiguity.ambiguous ? `Ambiguous: ${candidate.ambiguity.alternativeCount} alternatives.` : "No alternatives reported."}</p>
          <ul>{candidate.signals.map(signal => <li key={signal.code}>{signal.code}: {signal.description}</li>)}</ul>
          {assessment ? <><p>Assessment rationale: {assessment.rationale}</p>{assessment.evidence ? <p>Evidence: {assessment.evidence.rationale}; {assessment.evidence.items.map(item => item.kind === "external" ? `${item.description} (${item.reference})` : item.kind === "internal" ? `Internal resource ${item.resourceId}, revision ${item.revision}` : "Evidence unavailable").join("; ")}</p> : null}
            {assessment.status === "STALE" ? <p role="status">STALE: {assessment.staleReasons.join(", ")}. Reload and reassess before binding.</p> : null}
            {writable && assessment.status === "CURRENT" && assessment.decision === "READY_FOR_BINDING" ? <button type="button" disabled={busy} onClick={() => void materialize(assessment)}>Create explicit binding in MY WORK</button> : null}
          </> : null}
          {writable && contextId ? <fieldset><legend>Private MY WORK assessment</legend><label>Rationale<textarea value={assessmentRationales[candidate.id] ?? assessment?.rationale ?? ""} onChange={event => setAssessmentRationales(value => ({ ...value, [candidate.id]: event.target.value }))} /></label><label>Evidence reference for READY<input value={assessmentEvidence[candidate.id]?.reference ?? ""} onChange={event => setAssessmentEvidence(value => ({ ...value, [candidate.id]: { reference: event.target.value, description: value[candidate.id]?.description ?? "" } }))} /></label><label>Evidence description for READY<input value={assessmentEvidence[candidate.id]?.description ?? ""} onChange={event => setAssessmentEvidence(value => ({ ...value, [candidate.id]: { reference: value[candidate.id]?.reference ?? "", description: event.target.value } }))} /></label><button type="button" disabled={candidateBusy} onClick={() => void assessCandidate(candidate, "NEEDS_EVIDENCE")}>Needs evidence</button><button type="button" disabled={candidateBusy} onClick={() => void assessCandidate(candidate, "REJECTED")}>Reject</button><button type="button" disabled={candidateBusy} onClick={() => void assessCandidate(candidate, "READY_FOR_BINDING")}>Ready for binding</button></fieldset> : null}
        </li>;
      })}</ul>
      {nextCandidateCursor ? <button type="button" disabled={candidateBusy} onClick={() => setCandidateCursor(nextCandidateCursor)}>Load next candidates</button> : null}
    </section>
    {error ? <p role="alert">{error}</p> : null}
  </section>;
}
