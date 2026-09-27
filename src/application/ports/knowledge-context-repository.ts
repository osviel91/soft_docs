import type { PrivateWorkContext } from "../../domain/workspace/knowledge-context";
import type { SemanticMessageIdentity } from "../../domain/workspace/metadata";

export interface KnowledgeContextRepository {
  listPrivate(projectId: string, ownerUserId: string): Promise<PrivateWorkContext[]>;
  findPrivate(projectId: string, contextId: string, ownerUserId: string): Promise<PrivateWorkContext | null>;
  createPrivate(input: { projectId: string; ownerUserId: string; name: string; description?: string }): Promise<PrivateWorkContext>;
  updatePrivate(contextId: string, ownerUserId: string, input: { name?: string; description?: string; lifecycle?: "active" | "archived" }): Promise<PrivateWorkContext>;
  deletePrivate(contextId: string, ownerUserId: string): Promise<void>;
  listPrivateMessages(projectId: string, contextId: string): Promise<SemanticMessageIdentity[]>;
  createPrivateMessage(input: { projectId: string; contextId: string; id: string; name: string; kind: "event" | "command" }): Promise<SemanticMessageIdentity>;
}
