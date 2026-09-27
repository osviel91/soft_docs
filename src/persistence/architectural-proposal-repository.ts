import type { ArchitecturalProposalRepository } from "../application/ports/architectural-proposal-repository";
import type { ArchitecturalProposal, ArchitecturalProposalSummary, ProposalRelationshipSnapshot, ProposalResourceSnapshot, ProposalSemanticMessageSnapshot } from "../domain/workspace/architectural-proposal";
import type { ResourceMetadata } from "../domain/workspace/resource-metadata";
import type { ResourceType } from "../domain/workspace/resource-id";
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

function proposalOf(row: Record<string, unknown>, resources: ProposalResourceSnapshot[], messages: ProposalSemanticMessageSnapshot[], relationships: ProposalRelationshipSnapshot[]): ArchitecturalProposal {
  const revisions = (typeof row.base_shared_resource_revisions === "string" ? JSON.parse(row.base_shared_resource_revisions) : row.base_shared_resource_revisions) as Record<string, number>;
  return {
    id: String(row.id), projectId: String(row.project_id), authorUserId: String(row.author_user_id),
    sourcePrivateContextId: String(row.source_private_context_id), title: String(row.title),
    ...(row.description == null ? {} : { description: String(row.description) }), status: "open",
    baseSharedRevision: String(row.base_shared_revision), baseSharedResourceRevisions: revisions,
    createdAt: date(row.created_at), submittedAt: date(row.submitted_at), resources, semanticMessages: messages, relationships,
  };
}

export function createArchitecturalProposalRepository(client: SqlClient, options: { newId?: IdGenerator } = {}): ArchitecturalProposalRepository {
  const newId = options.newId ?? createIdGenerator();

  const currentSharedRevision = async (db: SqlClient, projectId: string) => {
    const result = await db.query("SELECT id, revision FROM resources WHERE project_id = $1 AND knowledge_context_id IS NULL ORDER BY id", [projectId]);
    const resources = Object.fromEntries(result.rows.map((row) => [String(row.id), Number(row.revision)]));
    return { revision: fingerprint(resources), resources };
  };

  const children = async (db: SqlClient, proposalId: string) => {
    const [resourceRows, messageRows, relationshipRows] = await Promise.all([
      db.query("SELECT * FROM architectural_proposal_resources WHERE proposal_id = $1 ORDER BY path, source_resource_id", [proposalId]),
      db.query("SELECT * FROM architectural_proposal_messages WHERE proposal_id = $1 ORDER BY name, message_id", [proposalId]),
      db.query("SELECT * FROM architectural_proposal_relationships WHERE proposal_id = $1 ORDER BY source_id, target_id", [proposalId]),
    ]);
    const resources = resourceRows.rows.map((row): ProposalResourceSnapshot => ({
      sourceResourceId: String(row.source_resource_id), path: String(row.path), type: row.type as ResourceType,
      sourceRevision: Number(row.source_revision), content: String(row.content), ...(metadata(row.metadata) ? { metadata: metadata(row.metadata) } : {}),
    }));
    const messages = messageRows.rows.map((row): ProposalSemanticMessageSnapshot => ({ id: String(row.message_id), name: String(row.name), kind: row.kind as "event" | "command", sourceContextId: String(row.source_context_id) }));
    const relationships = relationshipRows.rows.map((row): ProposalRelationshipSnapshot => ({
      kind: row.kind as ProposalRelationshipSnapshot["kind"], sourceId: String(row.source_id), targetId: String(row.target_id), sourceContextId: String(row.source_context_id),
      ...(row.source_role ? { sourceRole: row.source_role as ProposalRelationshipSnapshot["sourceRole"] } : {}),
      ...(row.target_role ? { targetRole: row.target_role as ProposalRelationshipSnapshot["targetRole"] } : {}),
      contextId: String(row.source_context_id),
    }));
    return { resources, messages, relationships };
  };

  return {
    async submit(input) {
      const title = input.title.trim();
      if (!title) throw new Error("A proposal title is required.");
      if (input.selections.length === 0) throw new Error("Select at least one private resource.");
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
        const proposalId = newId();
        const inserted = await tx.query(
          `INSERT INTO architectural_proposals (id, project_id, author_user_id, source_private_context_id, title, description, base_shared_revision, base_shared_resource_revisions)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb) RETURNING *`,
          [proposalId, input.projectId, input.authorUserId, input.sourcePrivateContextId, title, input.description ?? null, input.baseSharedRevision, JSON.stringify(input.baseSharedResourceRevisions)],
        );
        for (const row of selected.rows) {
          await tx.query(
            `INSERT INTO architectural_proposal_resources (proposal_id, source_resource_id, path, type, source_revision, content, metadata)
             VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
            [proposalId, String(row.id), String(row.path), String(row.snapshot_type), Number(row.revision), String(row.snapshot_content), typeof row.snapshot_metadata === "string" ? row.snapshot_metadata : JSON.stringify(row.snapshot_metadata ?? {})],
          );
        }
        if (input.privateMessageIds.length > 0) {
          const messages = await tx.query("SELECT id, name, kind FROM private_semantic_messages WHERE project_id = $1 AND knowledge_context_id = $2 AND id = ANY($3::uuid[]) ORDER BY id", [input.projectId, input.sourcePrivateContextId, input.privateMessageIds]);
          if (messages.rows.length !== input.privateMessageIds.length) throw new Error("A private semantic identity dependency is no longer available.");
          for (const row of messages.rows) await tx.query("INSERT INTO architectural_proposal_messages (proposal_id, message_id, name, kind, source_context_id) VALUES ($1, $2, $3, $4, $5)", [proposalId, String(row.id), String(row.name), String(row.kind), input.sourcePrivateContextId]);
        }
        const relationships = await tx.query("SELECT source_id, target_id, kind, source_role, target_role FROM resource_relationships WHERE project_id = $1 AND knowledge_context_id = $2 AND source_id = ANY($3::uuid[]) AND target_id = ANY($3::uuid[]) ORDER BY source_id, target_id", [input.projectId, input.sourcePrivateContextId, ids]);
        for (const row of relationships.rows) await tx.query("INSERT INTO architectural_proposal_relationships (proposal_id, source_id, target_id, kind, source_role, target_role, source_context_id) VALUES ($1, $2, $3, $4, $5, $6, $7)", [proposalId, String(row.source_id), String(row.target_id), String(row.kind), row.source_role == null ? null : String(row.source_role), row.target_role == null ? null : String(row.target_role), input.sourcePrivateContextId]);
        const storedChildren = await children(tx, proposalId);
        return proposalOf(inserted.rows[0], storedChildren.resources, storedChildren.messages, storedChildren.relationships);
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
      return proposalOf(result.rows[0], storedChildren.resources, storedChildren.messages, storedChildren.relationships);
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
