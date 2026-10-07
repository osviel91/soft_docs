import type { ArchitecturalProposalRepository } from "../application/ports/architectural-proposal-repository";
import type { ArchitecturalProposal, ArchitecturalProposalSummary, ProposalRelationshipSnapshot, ProposalResourceSnapshot, ProposalSemanticMessageSnapshot, ProposalSemanticBindingSnapshot } from "../domain/workspace/architectural-proposal";
import type { ResourceMetadata } from "../domain/workspace/resource-metadata";
import { resourceTypeOfName, type ResourceType } from "../domain/workspace/resource-id";
import type { SqlClient } from "./sql-client";
import { createIdGenerator, type IdGenerator } from "../shared/ids/uuid";

function fingerprint(resources: Record<string, number>): string {
  return JSON.stringify(Object.entries(resources).sort(([a], [b]) => a.localeCompare(b)));
}

function date(value: unknown): Date {
  return value instanceof Date ? value : new Date(String(value));
}

function metadata(value: unknown): ResourceMetadata | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as ResourceMetadata;
}

function isResourceType(value: unknown): value is ResourceType {
  return value === "sequence-diagram" || value === "event-flow" || value === "markdown-document" || value === "conceptual" || value === "database";
}

function proposalOf(row: Record<string, unknown>, resources: ProposalResourceSnapshot[], messages: ProposalSemanticMessageSnapshot[], relationships: ProposalRelationshipSnapshot[], semanticBindings: ProposalSemanticBindingSnapshot[] = []): ArchitecturalProposal {
  const revisions = (typeof row.base_shared_resource_revisions === "string" ? JSON.parse(row.base_shared_resource_revisions) : row.base_shared_resource_revisions) as Record<string, number>;
  return {
    id: String(row.id), projectId: String(row.project_id), authorUserId: String(row.author_user_id),
    sourcePrivateContextId: String(row.source_private_context_id), title: String(row.title),
     ...(row.description == null ? {} : { description: String(row.description) }), status: row.status as ArchitecturalProposal["status"],
     supersedesProposalId: row.supersedes_proposal_id == null ? null : String(row.supersedes_proposal_id),
     withdrawnAt: row.withdrawn_at == null ? null : date(row.withdrawn_at),
     withdrawnBy: row.withdrawn_by == null ? null : String(row.withdrawn_by),
     withdrawalReason: row.withdrawal_reason == null ? null : String(row.withdrawal_reason),
     supersededAt: row.superseded_at == null ? null : date(row.superseded_at),
    baseSharedRevision: String(row.base_shared_revision), baseSharedResourceRevisions: revisions,
    baseManifestRevision: row.base_manifest_revision == null ? null : Number(row.base_manifest_revision),
     createdAt: date(row.created_at), submittedAt: date(row.submitted_at), resources, semanticMessages: messages, relationships, semanticBindings,
  };
}

export function createArchitecturalProposalRepository(client: SqlClient, options: { newId?: IdGenerator } = {}): ArchitecturalProposalRepository {
  const newId = options.newId ?? createIdGenerator();

  const snapshotBindings = async (tx: SqlClient, proposalId: string, input: { projectId: string; sourcePrivateContextId: string; semanticBindings?: import("../application/ports/architectural-proposal-repository").ProposalSemanticBindingSelection[] }) => {
    for (const selection of input.semanticBindings ?? []) {
      const contextId = input.sourcePrivateContextId;
      const privateResult = selection.operation === "REMOVE" ? null : await tx.query("SELECT binding, revision FROM semantic_bindings WHERE project_id = $1 AND knowledge_context_id = $2 AND id = $3 FOR UPDATE", [input.projectId, input.sourcePrivateContextId, selection.bindingId]);
      const baseResult = selection.operation === "ADD" ? null : await tx.query("SELECT binding, revision FROM semantic_bindings WHERE project_id = $1 AND knowledge_context_id IS NULL AND id = $2 FOR UPDATE", [input.projectId, selection.bindingId]);
      const result = selection.operation === "REMOVE" ? baseResult : privateResult;
      if (!result?.rows[0]) throw new Error(`Semantic binding ${selection.bindingId} is unavailable in the required context.`);
      const binding = (typeof result.rows[0].binding === "string" ? JSON.parse(result.rows[0].binding) : result.rows[0].binding) as import("../domain/workspace/semantic-binding").SemanticBinding;
      const revision = Number(result.rows[0].revision);
      if (selection.operation === "ADD" && revision !== 1) throw new Error(`New semantic binding ${selection.bindingId} must be at revision 1.`);
       if (selection.operation !== "ADD") {
        const baseBinding = (typeof baseResult?.rows[0]?.binding === "string" ? JSON.parse(baseResult.rows[0].binding) : baseResult?.rows[0]?.binding) as import("../domain/workspace/semantic-binding").SemanticBinding | undefined;
        if (!baseBinding || Number(baseResult?.rows[0]?.revision) !== selection.expectedRevision) throw new Error(`SHARED semantic binding ${selection.bindingId} changed since it was read.`);
        const fingerprintValue = JSON.stringify(baseBinding);
        if (fingerprintValue !== selection.baseFingerprint) throw new Error(`Semantic binding ${selection.bindingId} base fingerprint does not match.`);
        if (selection.operation === "UPDATE" && binding.id !== baseBinding.id) throw new Error(`Private semantic binding ${selection.bindingId} does not correspond to its SHARED base.`);
       }
       if (selection.operation !== "REMOVE" && revision !== selection.sourceRevision) throw new Error(`Private semantic binding ${selection.bindingId} changed during proposal submission; re-read and retry.`);
       const baseBinding = selection.operation === "ADD" ? null : (typeof baseResult?.rows[0]?.binding === "string" ? JSON.parse(baseResult.rows[0].binding) : baseResult?.rows[0]?.binding);
       await tx.query("INSERT INTO architectural_proposal_bindings (proposal_id, binding_id, operation, source_context_id, source_revision, expected_revision, base_fingerprint, binding, base_binding) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb)", [proposalId, selection.bindingId, selection.operation, contextId, selection.operation === "REMOVE" ? null : selection.sourceRevision, selection.operation === "ADD" ? null : selection.expectedRevision, selection.operation === "ADD" ? null : selection.baseFingerprint, JSON.stringify(binding), baseBinding == null ? null : JSON.stringify(baseBinding)]);
    }
  };

  const currentSharedRevision = async (db: SqlClient, projectId: string) => {
    const result = await db.query("SELECT id, revision FROM resources WHERE project_id = $1 AND knowledge_context_id IS NULL AND lifecycle = 'ACTIVE' ORDER BY id", [projectId]);
    const resources = Object.fromEntries(result.rows.map((row) => [String(row.id), Number(row.revision)]));
    return { revision: fingerprint(resources), resources };
  };

  const children = async (db: SqlClient, proposalId: string) => {
    const [resourceRows, messageRows, relationshipRows, bindingRows] = await Promise.all([
      db.query(`SELECT apr.*, source_revision.type AS source_revision_type
                  FROM architectural_proposal_resources apr
                  LEFT JOIN resource_revisions source_revision
                    ON source_revision.resource_id = apr.source_resource_id
                   AND source_revision.revision = apr.source_revision
                 WHERE apr.proposal_id = $1
                 ORDER BY apr.path, apr.source_resource_id`, [proposalId]),
      db.query("SELECT * FROM architectural_proposal_messages WHERE proposal_id = $1 ORDER BY name, message_id", [proposalId]),
      db.query("SELECT * FROM architectural_proposal_relationships WHERE proposal_id = $1 ORDER BY source_id, target_id", [proposalId]),
      db.query("SELECT * FROM architectural_proposal_bindings WHERE proposal_id = $1 ORDER BY binding_id", [proposalId]),
    ]);
    const resources = resourceRows.rows.map((row): ProposalResourceSnapshot => {
      const type = isResourceType(row.type)
        ? row.type
        : isResourceType(row.source_revision_type)
          ? row.source_revision_type
          : resourceTypeOfName(String(row.path));
      return {
        sourceResourceId: String(row.source_resource_id), path: String(row.path), type,
        sourceRevision: Number(row.source_revision), content: String(row.content), ...(metadata(row.metadata) ? { metadata: metadata(row.metadata) } : {}),
        ...(row.operation == null ? {} : { operation: row.operation as ProposalResourceSnapshot["operation"] }),
         ...(row.base_resource_id == null ? {} : { baseResourceId: String(row.base_resource_id) }),
         ...(row.base_path == null ? {} : { basePath: String(row.base_path) }),
         ...(row.base_revision == null ? {} : { baseRevision: Number(row.base_revision) }),
      };
    });
    const messages = messageRows.rows.map((row): ProposalSemanticMessageSnapshot => ({ id: String(row.message_id), name: String(row.name), kind: row.kind as "event" | "command", sourceContextId: String(row.source_context_id), operation: row.operation as ProposalSemanticMessageSnapshot["operation"], ...(row.base_name == null ? {} : { baseName: String(row.base_name) }), ...(row.base_kind == null ? {} : { baseKind: row.base_kind as "event" | "command" }) }));
    const relationships = relationshipRows.rows.map((row): ProposalRelationshipSnapshot => ({
      kind: row.kind as ProposalRelationshipSnapshot["kind"], sourceId: String(row.source_id), targetId: String(row.target_id), sourceContextId: String(row.source_context_id),
      ...(row.source_role ? { sourceRole: row.source_role as ProposalRelationshipSnapshot["sourceRole"] } : {}),
      ...(row.target_role ? { targetRole: row.target_role as ProposalRelationshipSnapshot["targetRole"] } : {}),
      operation: row.operation as ProposalRelationshipSnapshot["operation"],
      ...(row.base_fingerprint == null ? {} : { baseFingerprint: String(row.base_fingerprint) }),
      contextId: String(row.source_context_id),
    }));
    const semanticBindings = bindingRows.rows.map((row): ProposalSemanticBindingSnapshot => ({ operation: row.operation as "ADD" | "UPDATE" | "REMOVE", binding: (typeof row.binding === "string" ? JSON.parse(row.binding) : row.binding) as import("../domain/workspace/semantic-binding").SemanticBinding, sourceContextId: String(row.source_context_id), ...(row.expected_revision == null ? {} : { expectedRevision: Number(row.expected_revision) }), ...(row.base_fingerprint == null ? {} : { baseFingerprint: String(row.base_fingerprint) }), ...(row.base_binding == null ? {} : { baseBinding: (typeof row.base_binding === "string" ? JSON.parse(row.base_binding) : row.base_binding) as import("../domain/workspace/semantic-binding").SemanticBinding }), ...(row.operation === "REMOVE" ? { bindingId: String(row.binding_id) } : {}) } as ProposalSemanticBindingSnapshot));
    return { resources, messages, relationships, semanticBindings };
  };

  return {
     async submit(input) {
      const title = input.title.trim();
      if (!title) throw new Error("A proposal title is required.");
      if (!Number.isInteger(input.baseManifestRevision) || input.baseManifestRevision < 0) throw new Error("A new proposal requires a concrete manifest revision.");
       if (input.selections.length === 0 && (input.retirements?.length ?? 0) === 0 && (input.semanticBindings?.length ?? 0) === 0) throw new Error("Select at least one resource, retirement, or semantic binding operation.");
        return client.transaction(async (tx) => {
        const ids = input.selections.map((selection) => selection.resourceId);
        const selected = await tx.query(
          "SELECT r.*, rr.content AS snapshot_content, rr.type AS snapshot_type, rr.metadata AS snapshot_metadata FROM resources r JOIN resource_revisions rr ON rr.resource_id = r.id AND rr.revision = r.revision WHERE r.project_id = $1 AND r.knowledge_context_id = $2 AND r.id = ANY($3::uuid[]) FOR UPDATE",
          [input.projectId, input.sourcePrivateContextId, ids],
        );
         if (selected.rows.length !== input.selections.length) throw new Error("One or more selected private resources are no longer available.");
        for (const selection of input.selections) {
          const row = selected.rows.find((candidate) => String(candidate.id) === selection.resourceId);
          if (!row || Number(row.revision) !== selection.expectedRevision) throw new Error(`Private resource ${selection.resourceId} changed during submission; re-read and retry.`);
         }
         const retirements = input.retirements ?? [];
         const retirementIds = retirements.map((selection) => selection.resourceId);
         const retired = retirementIds.length === 0 ? { rows: [] } : await tx.query(
           "SELECT r.*, rr.content AS snapshot_content, rr.type AS snapshot_type, rr.metadata AS snapshot_metadata FROM resources r JOIN resource_revisions rr ON rr.resource_id = r.id AND rr.revision = r.revision WHERE r.project_id = $1 AND r.knowledge_context_id IS NULL AND r.lifecycle = 'ACTIVE' AND r.id = ANY($2::uuid[]) FOR UPDATE",
           [input.projectId, retirementIds],
         );
         if (retired.rows.length !== retirementIds.length) throw new Error("One or more retirement targets are not active SHARED resources.");
         for (const selection of retirements) {
           const row = retired.rows.find((candidate) => String(candidate.id) === selection.resourceId);
           if (!row || Number(row.revision) !== selection.expectedRevision) throw new Error(`SHARED resource ${selection.resourceId} changed during proposal submission; re-read and retry.`);
         }
        const proposalId = newId();
        const inserted = await tx.query(
           `INSERT INTO architectural_proposals (id, project_id, author_user_id, source_private_context_id, title, description, base_shared_revision, base_shared_resource_revisions, base_manifest_revision)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9) RETURNING *`,
           [proposalId, input.projectId, input.authorUserId, input.sourcePrivateContextId, title, input.description ?? null, input.baseSharedRevision, JSON.stringify(input.baseSharedResourceRevisions), input.baseManifestRevision],
        );
        for (const row of selected.rows) {
          await tx.query(
             `INSERT INTO architectural_proposal_resources (proposal_id, source_resource_id, path, type, source_revision, content, metadata, operation, base_resource_id, base_path, base_revision)
              VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11)`,
             [proposalId, String(row.id), String(row.path), String(row.snapshot_type), Number(row.revision), String(row.snapshot_content), typeof row.snapshot_metadata === "string" ? row.snapshot_metadata : JSON.stringify(row.snapshot_metadata ?? {}), undefined, null, null, null],
           );
         }
          const sharedByPath = await tx.query("SELECT id, path, revision FROM resources WHERE project_id = $1 AND knowledge_context_id IS NULL AND lifecycle = 'ACTIVE'", [input.projectId]);
          for (const row of selected.rows) {
            const selection = input.selections.find((candidate) => candidate.resourceId === String(row.id))!;
            const base = selection.baseResourceId
              ? sharedByPath.rows.find((candidate) => String(candidate.id) === selection.baseResourceId)
              : sharedByPath.rows.find((candidate) => String(candidate.path) === String(row.path));
            const operation = selection.operation ?? (base ? "UPDATE" : "CREATE");
            await tx.query(
              `UPDATE architectural_proposal_resources SET path = $3, operation = $4, base_resource_id = $5, base_path = $6, base_revision = $7 WHERE proposal_id = $1 AND source_resource_id = $2`,
              [proposalId, String(row.id), selection.path ?? String(row.path), operation, base ? String(base.id) : null, base ? String(base.path) : null, selection.baseRevision ?? (base ? Number(base.revision) : null)],
            );
         }
         for (const row of retired.rows) {
           await tx.query(
              `INSERT INTO architectural_proposal_resources (proposal_id, source_resource_id, path, type, source_revision, content, metadata, operation, base_resource_id, base_path, base_revision)
               VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, 'RETIRE', $2, $3, $5)`,
             [proposalId, String(row.id), String(row.path), String(row.snapshot_type), Number(row.revision), String(row.snapshot_content), typeof row.snapshot_metadata === "string" ? row.snapshot_metadata : JSON.stringify(row.snapshot_metadata ?? {})],
           );
         }
         if ((input.semanticMessages?.length ?? 0) > 0 || input.privateMessageIds.length > 0) {
           const requested: Array<{ id: string; name?: string; kind?: "event" | "command"; operation?: "ADD" | "UPDATE" | "RETIRE"; baseName?: string; baseKind?: "event" | "command" }> = input.semanticMessages ?? input.privateMessageIds.map((id) => ({ id, operation: "ADD" as const }));
            const privateRequested = requested.filter((message) => message.operation !== "RETIRE");
           const requestedIds = privateRequested.map((message) => message.id);
           const messages = privateRequested.length === 0 ? { rows: [] } : await tx.query("SELECT id, name, kind FROM private_semantic_messages WHERE project_id = $1 AND knowledge_context_id = $2 AND id = ANY($3::uuid[]) ORDER BY id", [input.projectId, input.sourcePrivateContextId, requestedIds]);
            for (const requestedMessage of privateRequested) {
              const row = messages.rows.find((candidate) => String(candidate.id) === requestedMessage.id);
              const name = row ? String(row.name) : requestedMessage.name;
              const kind = row ? String(row.kind) : requestedMessage.kind;
              if (!name || !kind) throw new Error(`Semantic identity ${requestedMessage.id} is not available in private work.`);
              await tx.query("INSERT INTO architectural_proposal_messages (proposal_id, message_id, name, kind, source_context_id, operation, base_name, base_kind) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)", [proposalId, requestedMessage.id, name, kind, input.sourcePrivateContextId, requestedMessage.operation ?? "ADD", requestedMessage.baseName ?? null, requestedMessage.baseKind ?? null]);
            }
           for (const message of requested.filter((entry) => entry.operation === "RETIRE")) await tx.query("INSERT INTO architectural_proposal_messages (proposal_id, message_id, name, kind, source_context_id, operation, base_name, base_kind) VALUES ($1, $2, $3, $4, $5, 'RETIRE', $6, $7)", [proposalId, message.id, message.name ?? message.baseName ?? message.id, message.kind ?? message.baseKind ?? "event", input.sourcePrivateContextId, message.baseName ?? message.name ?? message.id, message.baseKind ?? message.kind ?? "event"]);
         }
         const relationships = await tx.query("SELECT source_id, target_id, kind, source_role, target_role FROM resource_relationships WHERE project_id = $1 AND knowledge_context_id = $2 AND source_id = ANY($3::uuid[]) AND target_id = ANY($3::uuid[]) ORDER BY source_id, target_id", [input.projectId, input.sourcePrivateContextId, ids]);
         const requestedRelationships: Array<{ sourceId: string; targetId: string; kind: "complementary-view"; sourceRole?: "execution" | "causal" | "other"; targetRole?: "execution" | "causal" | "other"; operation?: "ADD" | "UPDATE" | "REMOVE"; baseFingerprint?: string }> = input.relationships ?? relationships.rows.map((row) => ({ sourceId: String(row.source_id), targetId: String(row.target_id), kind: row.kind as "complementary-view", ...(row.source_role == null ? {} : { sourceRole: row.source_role as "execution" | "causal" | "other" }), ...(row.target_role == null ? {} : { targetRole: row.target_role as "execution" | "causal" | "other" }) }));
          for (const relationship of requestedRelationships) await tx.query("INSERT INTO architectural_proposal_relationships (proposal_id, source_id, target_id, kind, source_role, target_role, source_context_id, operation, base_fingerprint) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)", [proposalId, relationship.sourceId, relationship.targetId, relationship.kind, relationship.sourceRole ?? null, relationship.targetRole ?? null, input.sourcePrivateContextId, relationship.operation ?? "ADD", relationship.baseFingerprint ?? null]);
          await snapshotBindings(tx, proposalId, input);
        const storedChildren = await children(tx, proposalId);
          return proposalOf(inserted.rows[0], storedChildren.resources, storedChildren.messages, storedChildren.relationships, storedChildren.semanticBindings);
       });
     },
     async revise(input) {
       return client.transaction(async (tx) => {
         const prior = await tx.query("SELECT status FROM architectural_proposals WHERE project_id = $1 AND id = $2 AND author_user_id = $3 FOR UPDATE", [input.projectId, input.supersedesProposalId, input.authorUserId]);
         if (!prior.rows[0]) throw new Error("The proposal does not exist or is not authored by the current actor.");
         if (String(prior.rows[0].status) !== "open") throw new Error("Only open proposals may be revised.");
         const promotion = await tx.query("SELECT status FROM promotions WHERE project_id = $1 AND proposal_id = $2 FOR UPDATE", [input.projectId, input.supersedesProposalId]);
         if (promotion.rows.some((row) => ["COMMITTED_COMPLETION_PENDING", "COMPLETED"].includes(String(row.status)))) throw new Error("A proposal with promotion evidence cannot be revised.");
         const successor = await tx.query("SELECT 1 FROM architectural_proposals WHERE supersedes_proposal_id = $1", [input.supersedesProposalId]);
         if (successor.rows.length > 0) throw new Error("The proposal already has a successor.");
         const freshBase = await currentSharedRevision(tx, input.projectId);
         const ids = input.selections.map((selection) => selection.resourceId);
         const selected = await tx.query("SELECT r.*, rr.content AS snapshot_content, rr.type AS snapshot_type, rr.metadata AS snapshot_metadata FROM resources r JOIN resource_revisions rr ON rr.resource_id = r.id AND rr.revision = r.revision WHERE r.project_id = $1 AND r.knowledge_context_id = $2 AND r.id = ANY($3::uuid[]) FOR UPDATE", [input.projectId, input.sourcePrivateContextId, ids]);
         if (selected.rows.length !== input.selections.length) throw new Error("One or more selected private resources are no longer available.");
         for (const selection of input.selections) {
           const row = selected.rows.find((candidate) => String(candidate.id) === selection.resourceId);
           if (!row || Number(row.revision) !== selection.expectedRevision) throw new Error(`Private resource ${selection.resourceId} changed during revision; re-read and retry.`);
         }
         const retirements = input.retirements ?? [];
         const retired = retirements.length === 0 ? { rows: [] } : await tx.query("SELECT r.*, rr.content AS snapshot_content, rr.type AS snapshot_type, rr.metadata AS snapshot_metadata FROM resources r JOIN resource_revisions rr ON rr.resource_id = r.id AND rr.revision = r.revision WHERE r.project_id = $1 AND r.knowledge_context_id IS NULL AND r.lifecycle = 'ACTIVE' AND r.id = ANY($2::uuid[]) FOR UPDATE", [input.projectId, retirements.map((selection) => selection.resourceId)]);
         if (retired.rows.length !== retirements.length) throw new Error("One or more retirement targets are not active SHARED resources.");
         for (const selection of retirements) {
           const row = retired.rows.find((candidate) => String(candidate.id) === selection.resourceId);
           if (!row || Number(row.revision) !== selection.expectedRevision) throw new Error(`SHARED resource ${selection.resourceId} changed during revision; re-read and retry.`);
         }
         const proposalId = newId();
         const inserted = await tx.query("INSERT INTO architectural_proposals (id, project_id, author_user_id, source_private_context_id, title, description, base_shared_revision, base_shared_resource_revisions, base_manifest_revision, supersedes_proposal_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10) RETURNING *", [proposalId, input.projectId, input.authorUserId, input.sourcePrivateContextId, input.title.trim(), input.description ?? null, freshBase.revision, JSON.stringify(freshBase.resources), input.baseManifestRevision, input.supersedesProposalId]);
         for (const row of selected.rows) {
           const selection = input.selections.find((candidate) => candidate.resourceId === String(row.id))!;
           const shared = await tx.query("SELECT id, path, revision FROM resources WHERE project_id = $1 AND knowledge_context_id IS NULL AND lifecycle = 'ACTIVE'", [input.projectId]);
           const base = selection.baseResourceId ? shared.rows.find((candidate) => String(candidate.id) === selection.baseResourceId) : shared.rows.find((candidate) => String(candidate.path) === String(row.path));
            await tx.query("INSERT INTO architectural_proposal_resources (proposal_id, source_resource_id, path, type, source_revision, content, metadata, operation, base_resource_id, base_path, base_revision) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11)", [proposalId, String(row.id), selection.path ?? String(row.path), String(row.snapshot_type), Number(row.revision), String(row.snapshot_content), typeof row.snapshot_metadata === "string" ? row.snapshot_metadata : JSON.stringify(row.snapshot_metadata ?? {}), selection.operation ?? (base ? "UPDATE" : "CREATE"), base ? String(base.id) : null, base ? String(base.path) : null, selection.baseRevision ?? (base ? Number(base.revision) : null)]);
         }
         for (const row of retired.rows) await tx.query("INSERT INTO architectural_proposal_resources (proposal_id, source_resource_id, path, type, source_revision, content, metadata, operation, base_resource_id, base_path, base_revision) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, 'RETIRE', $2, $3, $5)", [proposalId, String(row.id), String(row.path), String(row.snapshot_type), Number(row.revision), String(row.snapshot_content), typeof row.snapshot_metadata === "string" ? row.snapshot_metadata : JSON.stringify(row.snapshot_metadata ?? {})]);
         const requestedMessages = input.semanticMessages ?? input.privateMessageIds.map((id) => ({ id, name: undefined, kind: undefined, operation: "ADD" as const, baseName: undefined, baseKind: undefined }));
         if (requestedMessages.length > 0) {
           const privateRows = await tx.query("SELECT id, name, kind FROM private_semantic_messages WHERE project_id = $1 AND knowledge_context_id = $2 AND id = ANY($3::uuid[])", [input.projectId, input.sourcePrivateContextId, requestedMessages.map((message) => message.id)]);
           for (const message of requestedMessages) {
             const row = privateRows.rows.find((candidate) => String(candidate.id) === message.id);
             const name = row ? String(row.name) : message.name;
             const kind = row ? String(row.kind) : message.kind;
             if (!name || !kind) throw new Error(`Semantic identity ${message.id} is not available in private work.`);
             await tx.query("INSERT INTO architectural_proposal_messages (proposal_id, message_id, name, kind, source_context_id, operation, base_name, base_kind) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)", [proposalId, message.id, name, kind, input.sourcePrivateContextId, message.operation ?? "ADD", message.baseName ?? null, message.baseKind ?? null]);
           }
         }
          for (const relationship of input.relationships ?? []) await tx.query("INSERT INTO architectural_proposal_relationships (proposal_id, source_id, target_id, kind, source_role, target_role, source_context_id, operation, base_fingerprint) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)", [proposalId, relationship.sourceId, relationship.targetId, relationship.kind, relationship.sourceRole ?? null, relationship.targetRole ?? null, input.sourcePrivateContextId, relationship.operation ?? "ADD", relationship.baseFingerprint ?? null]);
          await snapshotBindings(tx, proposalId, input);
         await tx.query("UPDATE architectural_proposals SET status = 'superseded', superseded_at = now() WHERE id = $1", [input.supersedesProposalId]);
         const storedChildren = await children(tx, proposalId);
          return proposalOf(inserted.rows[0], storedChildren.resources, storedChildren.messages, storedChildren.relationships, storedChildren.semanticBindings);
       });
     },
     async withdraw(proposalId, authorUserId, reason) {
       return client.transaction(async (tx) => {
         const prior = await tx.query("SELECT * FROM architectural_proposals WHERE id = $1 AND author_user_id = $2 FOR UPDATE", [proposalId, authorUserId]);
         if (!prior.rows[0]) throw new Error("The proposal does not exist or is not authored by the current actor.");
         if (String(prior.rows[0].status) !== "open") throw new Error("Only open proposals may be withdrawn.");
         const promotion = await tx.query("SELECT status FROM promotions WHERE proposal_id = $1 FOR UPDATE", [proposalId]);
         if (promotion.rows.some((row) => ["COMMITTED_COMPLETION_PENDING", "COMPLETED"].includes(String(row.status)))) throw new Error("A proposal with promotion evidence cannot be withdrawn.");
         const updated = await tx.query("UPDATE architectural_proposals SET status = 'withdrawn', withdrawn_at = now(), withdrawn_by = $2, withdrawal_reason = $3 WHERE id = $1 RETURNING *", [proposalId, authorUserId, reason?.trim() || null]);
         const storedChildren = await children(tx, proposalId);
          return proposalOf(updated.rows[0], storedChildren.resources, storedChildren.messages, storedChildren.relationships, storedChildren.semanticBindings);
       });
     },
    async list(projectId) {
      const [result, current] = await Promise.all([
        client.query("SELECT * FROM architectural_proposals WHERE project_id = $1 ORDER BY submitted_at DESC, id DESC", [projectId]),
        currentSharedRevision(client, projectId),
      ]);
      return result.rows.map((row): ArchitecturalProposalSummary => ({ ...proposalOf(row, [], [], []), staleBase: String(row.base_shared_revision) !== current.revision, currentSharedRevision: current.revision }));
    },
    async get(projectId, proposalId) {
      const result = await client.query("SELECT * FROM architectural_proposals WHERE project_id = $1 AND id = $2", [projectId, proposalId]);
      if (!result.rows[0]) return null;
      const storedChildren = await children(client, proposalId);
      return proposalOf(result.rows[0], storedChildren.resources, storedChildren.messages, storedChildren.relationships, storedChildren.semanticBindings);
    },
    async findSuccessor(projectId, proposalId) {
      const result = await client.query("SELECT * FROM architectural_proposals WHERE project_id = $1 AND supersedes_proposal_id = $2 ORDER BY submitted_at DESC, id DESC LIMIT 1", [projectId, proposalId]);
      if (!result.rows[0]) return null;
      const storedChildren = await children(client, String(result.rows[0].id));
      return proposalOf(result.rows[0], storedChildren.resources, storedChildren.messages, storedChildren.relationships, storedChildren.semanticBindings);
    },
    async hasForContext(projectId, contextId) {
      const result = await client.query("SELECT 1 FROM architectural_proposals WHERE project_id = $1 AND source_private_context_id = $2 LIMIT 1", [projectId, contextId]);
      return result.rows.length > 0;
    },
    currentSharedRevision(projectId) {
      return currentSharedRevision(client, projectId);
    },
  };
}
