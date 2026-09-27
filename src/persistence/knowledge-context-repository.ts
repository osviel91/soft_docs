import type { KnowledgeContextRepository } from "../application/ports/knowledge-context-repository";
import type { PrivateWorkContext } from "../domain/workspace/knowledge-context";
import type { SqlClient } from "./sql-client";
import { createIdGenerator, type IdGenerator } from "../shared/ids/uuid";

const contextOf = (row: Record<string, unknown>): PrivateWorkContext => ({
  kind: "private-work",
  id: String(row.id),
  projectId: String(row.project_id),
  ownerUserId: String(row.owner_user_id),
  name: String(row.name),
  ...(row.description == null ? {} : { description: String(row.description) }),
  lifecycle: row.lifecycle === "archived" ? "archived" : "active",
  createdAt: row.created_at instanceof Date ? row.created_at : new Date(String(row.created_at)),
  updatedAt: row.updated_at instanceof Date ? row.updated_at : new Date(String(row.updated_at)),
});

export function createKnowledgeContextRepository(client: SqlClient, options: { newId?: IdGenerator } = {}): KnowledgeContextRepository {
  const newId = options.newId ?? createIdGenerator();
  return {
    async listPrivate(projectId, ownerUserId) {
      const result = await client.query(
        "SELECT * FROM knowledge_contexts WHERE project_id = $1 AND owner_user_id = $2 ORDER BY updated_at DESC, id DESC",
        [projectId, ownerUserId],
      );
      return result.rows.map(contextOf);
    },
    async findPrivate(projectId, contextId, ownerUserId) {
      const result = await client.query(
        "SELECT * FROM knowledge_contexts WHERE project_id = $1 AND id = $2 AND owner_user_id = $3",
        [projectId, contextId, ownerUserId],
      );
      return result.rows[0] ? contextOf(result.rows[0]) : null;
    },
    async createPrivate(input) {
      const name = input.name.trim();
      if (!name) throw new Error("A private work name is required.");
      const result = await client.query(
        `INSERT INTO knowledge_contexts (id, project_id, owner_user_id, name, description)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [newId(), input.projectId, input.ownerUserId, name, input.description ?? null],
      );
      return contextOf(result.rows[0]);
    },
    async updatePrivate(contextId, ownerUserId, input) {
      const assignments: string[] = ["updated_at = now()"]; const params: Array<string | null> = [contextId, ownerUserId];
      if (input.name !== undefined) { const name = input.name.trim(); if (!name) throw new Error("A private work name is required."); params.push(name); assignments.push(`name = $${params.length}`); }
      if (input.description !== undefined) { params.push(input.description); assignments.push(`description = $${params.length}`); }
      if (input.lifecycle !== undefined) { params.push(input.lifecycle); assignments.push(`lifecycle = $${params.length}`); }
      const result = await client.query(`UPDATE knowledge_contexts SET ${assignments.join(", ")} WHERE id = $1 AND owner_user_id = $2 RETURNING *`, params);
      if (!result.rows[0]) throw new Error("Private work context not found.");
      return contextOf(result.rows[0]);
    },
    async deletePrivate(contextId, ownerUserId) {
      const result = await client.query("DELETE FROM knowledge_contexts WHERE id = $1 AND owner_user_id = $2", [contextId, ownerUserId]);
      if (result.rowCount === 0) throw new Error("Private work context not found.");
    },
    async listPrivateMessages(projectId, contextId) {
      const result = await client.query("SELECT id, name, kind FROM private_semantic_messages WHERE project_id = $1 AND knowledge_context_id = $2 ORDER BY name, id", [projectId, contextId]);
      return result.rows.map((row) => ({ id: String(row.id), name: String(row.name), kind: row.kind as "event" | "command" }));
    },
    async createPrivateMessage(input) {
      const result = await client.query("INSERT INTO private_semantic_messages (id, project_id, knowledge_context_id, name, kind) VALUES ($1, $2, $3, $4, $5) RETURNING id, name, kind", [input.id, input.projectId, input.contextId, input.name, input.kind]);
      const row = result.rows[0];
      return { id: String(row.id), name: String(row.name), kind: row.kind as "event" | "command" };
    },
    async updatePrivateMessages(projectId, contextId, messages) {
      await client.transaction(async (tx) => {
        await tx.query("DELETE FROM private_semantic_messages WHERE project_id = $1 AND knowledge_context_id = $2", [projectId, contextId]);
        for (const message of messages) await tx.query("INSERT INTO private_semantic_messages (id, project_id, knowledge_context_id, name, kind) VALUES ($1, $2, $3, $4, $5)", [message.id, projectId, contextId, message.name, message.kind]);
      });
      return messages;
    },
  };
}
