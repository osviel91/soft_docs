import type { ApplicationContext } from "./context";
import { actorIdOf, actorTypeOf, credentialIdOf } from "./context";
import type { AuthorizationPolicy, WorkspaceAdminGovernance } from "./authorization";
import type { ProjectRepository } from "./ports/project-repository";
import type { ArchitecturalProposalRepository } from "./ports/architectural-proposal-repository";
import type { ProposalReviewRepository } from "./ports/proposal-review-repository";
import type { AuthoritativeBatchRepository, AuthoritativeBatchOperation } from "./ports/authoritative-batch-repository";
import type { ProjectStorage } from "./project-storage";
import type { Promotion, PromotionEntry, PromotionPreview, PromotionSemanticMessageChange } from "../domain/workspace/promotion";
import type { PromotionSemanticBindingChange } from "../domain/workspace/promotion";
import { validateSemanticBinding } from "../domain/workspace/semantic-binding";
import { conflict, forbidden, invalid, notFound, unavailable } from "./errors";
import { createEmptyMetadata, parseProjectMetadata, type ProjectMetadata } from "../domain/workspace/metadata";
import { createIdGenerator } from "../shared/ids/uuid";
import type { ResourceAuthorship } from "../domain/workspace/resource-revision";
import type { ServerProject } from "../domain/project/server-project";
import type { ResourceRelationship } from "../domain/workspace/resource-relationship";
import { createHash } from "node:crypto";
import { analyzeResource } from "../domain/project/resource-analysis";
import { entityAnchorKey, type IndexedEntity } from "../domain/workspace/semantic-binding";

function relationshipFingerprint(relationship: ResourceRelationship): string {
  return JSON.stringify({ kind: relationship.kind, sourceId: relationship.sourceId, targetId: relationship.targetId, sourceRole: relationship.sourceRole ?? null, targetRole: relationship.targetRole ?? null });
}

export interface PromotionService {
  preview(context: ApplicationContext, projectId: string, proposalId: string): Promise<PromotionPreview>;
  execute(context: ApplicationContext, projectId: string, proposalId: string, idempotencyKey?: string): Promise<Promotion>;
  recover(limit?: number): Promise<{ examined: number; completed: number; pending: number }>;
}

export function createPromotionService(options: {
  proposals: ArchitecturalProposalRepository;
  projects: ProjectRepository;
  reviews: ProposalReviewRepository;
  batches: AuthoritativeBatchRepository;
  promotions: import("./ports/promotion-repository").PromotionRepository;
  storage: (projectId: string) => ProjectStorage;
  policy: AuthorizationPolicy<ServerProject>;
  workspaceAdmin?: WorkspaceAdminGovernance;
}): PromotionService {
  const newId = createIdGenerator();
  const plan = async (projectId: string, proposalId: string) => {
    const proposal = await options.proposals.get(projectId, proposalId);
    if (!proposal) throw notFound(`No architectural proposal with id ${proposalId}.`);
    const current = await options.proposals.currentSharedRevision(projectId);
    const shared = await options.projects.listResources(projectId, null);
    const currentBindings = await options.batches.listSharedSemanticBindings(projectId);
    const manifest = await options.storage(projectId).read("project.json");
    if (!manifest.ok) throw unavailable("The project manifest could not be read.");
    let metadata: ProjectMetadata = createEmptyMetadata();
    if (manifest.value) {
      try { metadata = parseProjectMetadata(JSON.parse(manifest.value.content)) ?? createEmptyMetadata(); } catch { throw invalid("The project manifest is invalid and cannot be promoted safely."); }
    }
    const byPath = new Map(shared.map((resource) => [resource.path, resource]));
    const byId = new Map(shared.map((resource) => [resource.id, resource]));
    const entries: PromotionEntry[] = proposal.resources.map((resource) => {
      const operation = (resource as typeof resource & { operation?: PromotionEntry["operation"] }).operation;
      const explicitBaseId = (resource as typeof resource & { baseResourceId?: string }).baseResourceId;
      const existing = explicitBaseId ? byId.get(explicitBaseId) : byPath.get(resource.path);
      const kind = operation ?? (existing ? "UPDATE" : "CREATE");
      const baseResourceId = explicitBaseId ?? existing?.id;
      const baseRevision = resource.baseRevision ?? existing?.revision;
      const resultingResourceId = kind === "CREATE" ? newId() : baseResourceId ?? resource.sourceResourceId;
      const resultingRevision = kind === "CREATE" ? 1 : kind === "UPDATE" ? (existing?.revision ?? baseRevision ?? 0) + 1 : (existing?.revision ?? baseRevision ?? 0);
       return { id: newId(), proposalResourceId: resource.sourceResourceId, operation: kind, path: resource.path, type: resource.type, ...(baseResourceId ? { baseResourceId, basePath: resource.basePath, baseRevision } : {}), resultingResourceId, resultingRevision, resultingLifecycle: kind === "RETIRE" ? "RETIRED" : "ACTIVE" };
    });
    const blockers: PromotionPreview["blockers"] = [];
    if (proposal.status !== "open") blockers.push({ code: `PROPOSAL_${proposal.status.toUpperCase()}`, message: `This proposal is ${proposal.status} and is not eligible for promotion.` });
    if (proposal.baseSharedRevision !== current.revision) blockers.push({ code: "STALE_BASE", message: "SHARED changed since this proposal was submitted." });
    const legacy = proposal.baseManifestRevision === null;
    const hasLegacySemanticChanges = proposal.semanticMessages.some((message) => (message.operation ?? "ADD") !== "ADD") || proposal.relationships.some((relationship) => (relationship.operation ?? "ADD") !== "ADD");
    if (legacy && hasLegacySemanticChanges) blockers.push({ code: "LEGACY_SEMANTIC_REBASE_REQUIRED", message: "This legacy proposal contains semantic authority changes without a captured semantic base; recreate it under the governed model." });
    if (!legacy && proposal.baseManifestRevision !== (metadata.manifestRevision ?? 0)) blockers.push({ code: "STALE_MANIFEST", message: "The semantic manifest changed since this proposal was submitted." });
    for (const entry of entries) {
      if (entry.operation !== "CREATE" && !entry.baseResourceId) blockers.push({ code: "MISSING_RETIREMENT_TARGET", message: `The ${entry.operation} target for ${entry.path} is missing.` });
      if (entry.operation !== "CREATE" && entry.baseResourceId && !byId.has(entry.baseResourceId)) blockers.push({ code: "RETIREMENT_TARGET_NOT_ACTIVE", message: `The authoritative target for ${entry.path} is no longer active.`, resourceId: entry.baseResourceId });
      if (entry.operation === "CREATE" && byPath.has(entry.path)) blockers.push({ code: "CREATE_PATH_TAKEN", message: `A SHARED resource already exists at ${entry.path}.`, resourceId: byPath.get(entry.path)?.id });
      if (entry.operation !== "CREATE" && byPath.has(entry.path) && byPath.get(entry.path)?.id !== entry.baseResourceId) blockers.push({ code: "DESTINATION_PATH_TAKEN", message: `A SHARED resource already exists at ${entry.path}.`, resourceId: byPath.get(entry.path)?.id });
      if (entry.operation !== "CREATE" && entry.baseResourceId && byId.get(entry.baseResourceId)?.revision !== entry.baseRevision) blockers.push({ code: "BASE_MISMATCH", message: `Resource ${entry.path} changed since the proposal base.`, resourceId: entry.baseResourceId, expectedRevision: entry.baseRevision, currentRevision: byId.get(entry.baseResourceId)?.revision });
      if (entry.operation !== "CREATE" && entry.baseResourceId && entry.basePath !== undefined && byId.get(entry.baseResourceId)?.path !== entry.basePath) blockers.push({ code: "BASE_PATH_MISMATCH", message: `Resource ${entry.baseResourceId} moved since the proposal base.`, resourceId: entry.baseResourceId });
    }
    const reviews = await options.reviews.list(proposal.id);
    const latest = new Map<string, typeof reviews[number]>();
    for (const review of reviews) latest.set(review.reviewerUserId, review);
    const effective = [...latest.values()];
    const approvals = effective.filter((review) => review.decision === "APPROVE").length;
    const changesRequested = effective.filter((review) => review.decision === "REQUEST_CHANGES").length;
    const reviewStatus = effective.length === 0 ? "none" : approvals > 0 && changesRequested > 0 ? "mixed" : approvals > 0 ? "approved" : "changes-requested";
    if (reviewStatus !== "approved") blockers.push({ code: "REVIEW_REQUIRED", message: "An explicit approval is required and no effective change request may remain." });
    const entryByProposalId = new Map(entries.map((entry) => [entry.proposalResourceId, entry]));
    const relationships = proposal.relationships.map((relationship) => ({
      operation: relationship.operation ?? "ADD",
      relationship: {
        kind: relationship.kind,
        sourceId: entryByProposalId.get(relationship.sourceId)?.resultingResourceId ?? relationship.sourceId,
        targetId: entryByProposalId.get(relationship.targetId)?.resultingResourceId ?? relationship.targetId,
        ...(relationship.sourceRole === undefined ? {} : { sourceRole: relationship.sourceRole }),
        ...(relationship.targetRole === undefined ? {} : { targetRole: relationship.targetRole }),
      } satisfies ResourceRelationship,
      ...(relationship.baseFingerprint === undefined ? {} : { baseFingerprint: relationship.baseFingerprint }),
    }));
    const currentRelationships = new Map((metadata.relationships ?? []).map((relationship) => [`${relationship.sourceId}:${relationship.targetId}`, relationship]));
    for (const change of relationships) {
      const key = `${change.relationship.sourceId}:${change.relationship.targetId}`;
      const existing = currentRelationships.get(key);
      if (change.operation === "ADD" && existing && relationshipFingerprint(existing) !== relationshipFingerprint(change.relationship)) blockers.push({ code: "RELATIONSHIP_CONFLICT", message: `Relationship ${key} exists with different kind or roles; revise the proposal against current SHARED state.` });
      if (change.operation !== "ADD" && !existing) blockers.push({ code: "RELATIONSHIP_MISSING", message: `Relationship ${key} is no longer present.` });
      if (change.operation !== "ADD" && existing && change.baseFingerprint !== undefined && relationshipFingerprint(existing) !== change.baseFingerprint) blockers.push({ code: "RELATIONSHIP_BASE_MISMATCH", message: `Relationship ${key} changed since the proposal base.` });
      if (change.operation === "ADD" || change.operation === "UPDATE") currentRelationships.set(key, change.relationship);
      else currentRelationships.delete(key);
    }
    const semanticMessages: PromotionSemanticMessageChange[] = proposal.semanticMessages.map((message) => ({ operation: message.operation ?? "ADD", message: { id: message.id, name: message.name, kind: message.kind }, ...(message.baseName === undefined ? {} : { baseName: message.baseName }), ...(message.baseKind === undefined ? {} : { baseKind: message.baseKind }) }));
    for (const change of semanticMessages) {
      const existing = (metadata.semanticMessages ?? []).find((message) => message.id === change.message.id);
      if (change.operation === "ADD" && existing) blockers.push({ code: "SEMANTIC_ID_EXISTS", message: `Semantic identity ${change.message.id} already exists.` });
      if (change.operation !== "ADD" && !existing) blockers.push({ code: "SEMANTIC_ID_MISSING", message: `Semantic identity ${change.message.id} is no longer present.` });
       if (change.operation !== "ADD" && existing && change.baseName !== undefined && (existing.name !== change.baseName || (change.baseKind !== undefined && existing.kind !== change.baseKind))) blockers.push({ code: "SEMANTIC_BASE_MISMATCH", message: `Semantic identity ${change.message.id} changed since the proposal base.` });
    }
    const retiredResourceIds = new Set(entries.filter((entry) => entry.operation === "RETIRE").map((entry) => entry.resultingResourceId));
    const resourceIds = new Set(shared.map((resource) => resource.id).filter((id) => !retiredResourceIds.has(id)));
    const resultingIds = new Set(entries.filter((entry) => entry.operation !== "RETIRE").map((entry) => entry.resultingResourceId));
    const resolveId = (id: string) => entryByProposalId.get(id)?.resultingResourceId ?? id;
    const semanticBindings: PromotionSemanticBindingChange[] = (proposal.semanticBindings ?? []).map((operation) => {
      const binding = {
        ...operation.binding,
        revision: operation.operation === "ADD" ? 1 : operation.expectedRevision + 1,
        provenance: { ...operation.binding.provenance, contextId: undefined, proposalId: proposal.id },
        left: { ...operation.binding.left, resourceId: resolveId(operation.binding.left.resourceId) },
        right: { ...operation.binding.right, resourceId: resolveId(operation.binding.right.resourceId) },
        evidence: {
          ...operation.binding.evidence,
          items: operation.binding.evidence.items.map((item) => {
            if (item.kind !== "internal") return item;
            const selectedResource = proposal.resources.find((resource) => resource.sourceResourceId === item.resourceId);
            const promotedResource = selectedResource ? entryByProposalId.get(selectedResource.sourceResourceId) : undefined;
            return {
              ...item,
              resourceId: resolveId(item.resourceId),
              ...(selectedResource && promotedResource ? { revision: promotedResource.resultingRevision } : {}),
              ...(item.entity ? { entity: { ...item.entity, resourceId: resolveId(item.entity.resourceId) } } : {}),
            };
          }),
        },
      };
      if (operation.operation === "ADD") return { operation: "ADD", binding };
      return { operation: operation.operation, binding, expectedRevision: operation.expectedRevision, baseFingerprint: operation.baseFingerprint, ...(operation.operation === "REMOVE" ? { bindingId: operation.bindingId } : {}) } as PromotionSemanticBindingChange;
    });
    const replacedIds = new Set(entries.filter((entry) => entry.operation !== "CREATE").map((entry) => entry.baseResourceId));
    const projectedEntities: IndexedEntity[] = [];
    const proposalResourceByResultId = new Map<string, { sourceRevision: number; resultingRevision: number }>();
    for (const resource of shared) {
      if (replacedIds.has(resource.id) || retiredResourceIds.has(resource.id)) continue;
      const revision = await options.projects.getRevision(resource.id, resource.revision);
      if (!revision) continue;
      projectedEntities.push(...analyzeResource({ id: resource.id, projectId, path: resource.path, type: resource.type, title: resource.path }, revision.content).entities);
    }
    for (const resource of proposal.resources) {
      const entry = entryByProposalId.get(resource.sourceResourceId);
      if (!entry || entry.operation === "RETIRE") continue;
      proposalResourceByResultId.set(entry.resultingResourceId, { sourceRevision: resource.sourceRevision, resultingRevision: entry.resultingRevision });
      projectedEntities.push(...analyzeResource({ id: entry.resultingResourceId, projectId, path: entry.path, type: resource.type, title: entry.path }, resource.content).entities);
    }
    for (const operation of semanticBindings) {
      const binding = operation.binding;
      try { validateSemanticBinding(binding); } catch (error) { blockers.push({ code: "INVALID_BINDING", message: error instanceof Error ? error.message : `Semantic binding ${binding.id} is invalid.` }); }
      for (const id of [binding.left.resourceId, binding.right.resourceId, ...binding.evidence.items.filter((item) => item.kind === "internal").map((item) => item.resourceId)]) {
        if (!resourceIds.has(id) && !resultingIds.has(id)) blockers.push({ code: "BINDING_ENDPOINT_MISSING", message: `Semantic binding ${binding.id} references unavailable resource ${id}.`, resourceId: id });
      }
      for (const endpoint of [binding.left, binding.right]) {
        if (!projectedEntities.some((entity) => entityAnchorKey(entity.anchor) === entityAnchorKey(endpoint))) blockers.push({ code: "BINDING_ENDPOINT_UNRESOLVED", message: `Semantic binding ${binding.id} has an endpoint that does not resolve in the promoted resource snapshot.`, resourceId: endpoint.resourceId });
      }
      for (const item of binding.evidence.items) {
        if (item.kind !== "internal") continue;
        const proposalResource = proposalResourceByResultId.get(item.resourceId);
        if (proposalResource && item.revision !== proposalResource.resultingRevision) blockers.push({ code: "BINDING_EVIDENCE_REVISION_MISMATCH", message: `Evidence for binding ${binding.id} does not cite the resulting selected resource revision.`, resourceId: item.resourceId, expectedRevision: proposalResource.resultingRevision, currentRevision: item.revision });
        if (!proposalResource && !(await options.projects.getRevision(item.resourceId, item.revision))) blockers.push({ code: "BINDING_EVIDENCE_UNAVAILABLE", message: `Evidence revision ${item.revision} for binding ${binding.id} is unavailable.`, resourceId: item.resourceId, expectedRevision: item.revision });
        if (item.entity && !projectedEntities.some((entity) => entityAnchorKey(entity.anchor) === entityAnchorKey(item.entity!))) blockers.push({ code: "BINDING_EVIDENCE_ENTITY_UNRESOLVED", message: `Evidence entity for binding ${binding.id} does not resolve in the promoted snapshot.`, resourceId: item.resourceId });
      }
      const id = operation.operation === "REMOVE" ? operation.bindingId : binding.id;
      const existing = currentBindings.find((candidate) => candidate.id === id);
      if (operation.operation === "ADD" && existing) blockers.push({ code: "BINDING_ID_EXISTS", message: `Semantic binding ${id} already exists.` });
      if (operation.operation !== "ADD" && (!existing || existing.revision !== operation.expectedRevision || JSON.stringify(existing) !== operation.baseFingerprint)) blockers.push({ code: "BINDING_BASE_MISMATCH", message: `Semantic binding ${id} is missing or changed since the proposal base.`, expectedRevision: operation.expectedRevision, ...(existing ? { currentRevision: existing.revision } : {}) });
    }
    return { proposal, current, entries, blockers, reviewStatus, shared, relationships, semanticMessages, semanticBindings, metadata, manifestContent: manifest.value?.content ?? null };
  };
  const recover = async (limit = 100): Promise<{ examined: number; completed: number; pending: number }> => {
      const batches = await options.batches.listIncomplete(limit);
      let completed = 0;
      for (const batch of batches) {
        const store = options.storage(batch.projectId);
        let ready = true;
        for (const operation of batch.operations) {
          if (operation.operation === "retire") {
            if (operation.targetPath) { const removed = await store.remove(operation.targetPath); if (!removed.ok) ready = false; }
            continue;
          }
          if (!operation.stagedPath || !operation.targetPath) { ready = false; continue; }
          const promoted = await store.promote({ from: operation.stagedPath, to: operation.targetPath });
          if (!promoted.ok) {
            const target = await store.read(operation.targetPath);
            if (!target.ok || !target.value || !operation.contentHash || createHash("sha256").update(target.value.content, "utf8").digest("hex") !== operation.contentHash) ready = false;
          }
          if (ready && operation.sourcePath && operation.sourcePath !== operation.targetPath && !(await store.remove(operation.sourcePath)).ok) ready = false;
        }
        if (batch.manifest) {
          const current = await store.read("project.json");
          if (current.ok && current.value?.content === batch.manifest.content) {
            // The manifest write already happened; only the settlement marker was lost.
          } else if (current.ok && (current.value?.content ?? null) !== batch.manifest.expectedContent) {
            ready = false;
          } else if (!batch.manifest.stagedPath || !(await store.promote({ from: batch.manifest.stagedPath, to: "project.json" })).ok) {
            const settled = await store.read("project.json");
            if (!settled.ok || !settled.value || settled.value.content !== batch.manifest.content) ready = false;
          }
        }
        if (!ready) continue;
        await options.batches.complete(batch.id);
        if (batch.promotionId) await options.promotions.complete(batch.promotionId);
        completed += 1;
      }
      return { examined: batches.length, completed, pending: batches.length - completed };
  };
  return {
    recover,
    async preview(context, projectId, proposalId) {
      await options.policy.requirePermission(context, projectId, "project:read");
      const value = await plan(projectId, proposalId);
      const authorization = await options.policy.decide(context, projectId, "promotion:execute");
      const workspaceAdmin = !authorization.allowed && authorization.reason === "forbidden" && options.workspaceAdmin
        ? await options.workspaceAdmin(context, projectId, "promotion:execute")
        : false;
      const authorized = (authorization.allowed && authorization.role === "OWNER") || workspaceAdmin;
      if (!authorized) value.blockers.push({ code: "PROMOTION_PERMISSION", message: "Only project owners or authorized workspace admins may promote proposals." });
      const existing = await options.promotions.getForProposal(projectId, proposalId);
      const blockers = existing?.status === "COMMITTED_COMPLETION_PENDING"
        ? [...value.blockers, { code: "COMPLETION_PENDING", message: "This promotion committed SQL state and is awaiting authoritative manifest completion." }]
        : existing?.status === "COMPLETED"
          ? [...value.blockers, { code: "PROMOTION_COMPLETED", message: "This proposal already has completed promotion evidence." }]
          : value.blockers;
      return { proposalId, projectId, reviewStatus: value.reviewStatus as PromotionPreview["reviewStatus"], eligible: blockers.length === 0, blockers, baseSharedRevision: value.proposal.baseSharedRevision, currentSharedRevision: value.current.revision, staleBase: value.proposal.baseSharedRevision !== value.current.revision, creates: value.entries.filter((entry) => entry.operation === "CREATE"), updates: value.entries.filter((entry) => entry.operation === "UPDATE"), retires: value.entries.filter((entry) => entry.operation === "RETIRE"), semanticIdentityAdditions: value.semanticMessages.filter((message) => message.operation === "ADD").map((message) => message.message.id), semanticIdentityReuses: [], semanticChanges: value.semanticMessages, relationships: value.relationships, semanticBindings: value.semanticBindings };
    },
    async execute(context, projectId, proposalId, idempotencyKey) {
      const authorization = await options.policy.decide(context, projectId, "promotion:execute");
      const workspaceAdmin = !authorization.allowed && authorization.reason === "forbidden" && options.workspaceAdmin
        ? await options.workspaceAdmin(context, projectId, "promotion:execute")
        : false;
      if (!authorization.allowed && !workspaceAdmin) await options.policy.requirePermission(context, projectId, "promotion:execute");
      if (authorization.allowed && authorization.role !== "OWNER" && !workspaceAdmin) throw forbidden("Only project owners or workspace admins may promote proposals.");
      const addressed = await options.proposals.get(projectId, proposalId);
      if (!addressed) throw notFound(`No architectural proposal with id ${proposalId}.`);
      if (addressed.status !== "open") throw conflict("Only open proposals may be promoted.", { state: addressed.status });
      let prior = await options.promotions.getForProposal(projectId, proposalId);
      if (prior?.status === "COMPLETED") return prior;
      if (prior) { await recover(); prior = await options.promotions.getForProposal(projectId, proposalId); if (prior?.status === "COMPLETED") return prior; throw unavailable("The previous promotion is still awaiting authoritative completion."); }
      const value = await plan(projectId, proposalId);
      if (value.blockers.length) throw conflict("The proposal is not eligible for promotion.", { blockers: value.blockers });
      const storage = options.storage(projectId);
       const manifest = await storage.read("project.json");
       if (!manifest.ok) throw unavailable("The project manifest could not be read.");
       const metadata = value.metadata;
      const knownMessages = new Map((metadata.semanticMessages ?? []).map((message) => [message.id, message]));
       for (const change of value.semanticMessages) {
         const existing = knownMessages.get(change.message.id);
         if (change.operation === "ADD") {
           if (existing) throw conflict(`Semantic identity ${change.message.id} conflicts with the SHARED manifest.`);
           knownMessages.set(change.message.id, change.message);
         } else if (change.operation === "UPDATE") {
           if (!existing) throw conflict(`Semantic identity ${change.message.id} is missing from the SHARED manifest.`);
           knownMessages.set(change.message.id, change.message);
         } else {
           knownMessages.delete(change.message.id);
         }
      }
      const resourceRecords = [...metadata.resources];
      for (const entry of value.entries) {
        const existing = resourceRecords.find((resource) => resource.id === entry.resultingResourceId);
        if (entry.operation === "CREATE") resourceRecords.push({ id: entry.resultingResourceId, path: entry.path, type: entry.type, title: entry.path });
        else if (entry.operation === "RETIRE") {
          const index = resourceRecords.findIndex((resource) => resource.id === entry.resultingResourceId);
          if (index >= 0) resourceRecords.splice(index, 1);
        } else if (existing) { existing.path = entry.path; existing.type = entry.type; }
        else resourceRecords.push({ id: entry.resultingResourceId, path: entry.path, type: entry.type, title: entry.path });
      }
      const author: ResourceAuthorship = context.principal.actor.kind === "agent" ? { kind: "agent", agentId: context.principal.actor.agentId, credentialId: context.principal.actor.credentialId, subjectUserId: context.principal.subjectUserId } : { kind: "user", userId: context.principal.actor.userId, subjectUserId: context.principal.subjectUserId };
      const batchId = newId();
      const retiredIds = new Set(value.entries.filter((entry) => entry.operation === "RETIRE").map((entry) => entry.resultingResourceId));
      const nextRelationships = [...(metadata.relationships ?? []).filter((relationship) => !retiredIds.has(relationship.sourceId) && !retiredIds.has(relationship.targetId))];
      for (const change of value.relationships) {
        const index = nextRelationships.findIndex((relationship) => relationship.sourceId === change.relationship.sourceId && relationship.targetId === change.relationship.targetId);
        if (change.operation === "ADD" || change.operation === "UPDATE") {
          if (index >= 0) nextRelationships[index] = change.relationship;
          else nextRelationships.push(change.relationship);
        } else if (index >= 0) nextRelationships.splice(index, 1);
      }
      const nextMetadata = { ...metadata, manifestRevision: (metadata.manifestRevision ?? 0) + 1, resources: resourceRecords, semanticMessages: [...knownMessages.values()], relationships: nextRelationships };
      const manifestContent = JSON.stringify(nextMetadata, null, 2);
      const manifestStagedPath = `.sdd-staging/${batchId}/project.json`;
      const stagedManifest = await storage.write(manifestStagedPath, manifestContent);
      if (!stagedManifest.ok) throw unavailable("The promotion could not stage the project manifest.");
      const operations: AuthoritativeBatchOperation[] = [];
      for (const resource of value.proposal.resources) {
        const entry = value.entries.find((candidate) => candidate.proposalResourceId === resource.sourceResourceId)!;
        const stagedPath = `.promotion/${batchId}/${entry.resultingResourceId}`;
        if (entry.operation !== "RETIRE") {
          const staged = await storage.write(stagedPath, resource.content);
          if (!staged.ok) throw unavailable("The promotion could not stage a resource.");
           operations.push(entry.operation === "CREATE" ? { operation: "create", resourceId: entry.resultingResourceId, path: entry.path, type: entry.type, content: resource.content, metadata: resource.metadata, stagedPath } : { operation: "update", resourceId: entry.resultingResourceId, sourcePath: resource.basePath, path: entry.path, expectedRevision: entry.baseRevision!, content: resource.content, metadata: resource.metadata, stagedPath });
        } else operations.push({ operation: "retire", resourceId: entry.resultingResourceId, path: entry.path, expectedRevision: entry.baseRevision! });
      }
      const promotionId = newId();
      let batch;
      try {
        batch = await options.batches.claim({ batchId, projectId, actor: author, audit: { action: "proposal.promoted", subjectUserId: context.principal.subjectUserId, actorType: actorTypeOf(context.principal), actorId: actorIdOf(context.principal), credentialId: credentialIdOf(context.principal), authType: context.principal.authType, projectId, detail: { proposalId, batchId } }, operations, relationshipChanges: value.relationships, semanticChanges: value.semanticMessages, semanticBindingChanges: value.semanticBindings, manifest: { expectedRevision: metadata.manifestRevision ?? 0, expectedContent: manifest.value?.content ?? null, content: manifestContent, stagedPath: manifestStagedPath }, idempotencyKey: idempotencyKey ?? `promotion:${proposalId}`, promotion: { id: promotionId, proposalId, baseSharedRevision: value.proposal.baseSharedRevision, entries: value.entries, relationships: value.relationships, semanticMessages: value.semanticMessages, semanticBindings: value.semanticBindings, baseManifestRevision: value.metadata.manifestRevision ?? 0 } });
      } catch (error) {
        await storage.remove(manifestStagedPath);
        throw error;
      }
      for (const operation of batch.operations) {
        if (operation.operation === "retire") {
          if (operation.targetPath && !(await storage.remove(operation.targetPath)).ok) throw unavailable("The promotion is awaiting filesystem recovery.");
        } else if (operation.stagedPath && operation.targetPath) {
          const promoted = await storage.promote({ from: operation.stagedPath, to: operation.targetPath });
          if (!promoted.ok) {
            const settled = await storage.read(operation.targetPath);
            if (!settled.ok || !settled.value || !operation.contentHash || createHash("sha256").update(settled.value.content, "utf8").digest("hex") !== operation.contentHash) throw unavailable("The promotion is awaiting filesystem recovery.");
          }
          if (operation.sourcePath && operation.sourcePath !== operation.targetPath && !(await storage.remove(operation.sourcePath)).ok) throw unavailable("The promotion is awaiting filesystem recovery.");
        }
      }
      const currentManifest = await storage.read("project.json");
      if (!currentManifest.ok || (currentManifest.value?.content ?? null) !== (manifest.value?.content ?? null)) throw unavailable("The promotion is awaiting manifest recovery.");
      const written = await storage.promote({ from: manifestStagedPath, to: "project.json" });
      if (!written.ok) {
        const settled = await storage.read("project.json");
        if (!settled.ok || !settled.value || settled.value.content !== manifestContent) throw unavailable("The promotion is awaiting manifest recovery.");
      }
      await options.batches.complete(batch.id);
      await options.promotions.complete(promotionId);
      const promotion = await options.promotions.getForProposal(projectId, proposalId);
      if (!promotion) throw unavailable("The promotion was committed but its evidence is not readable yet.");
      return promotion;
    },
  };
}
