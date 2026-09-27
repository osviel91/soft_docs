/** The server-side architectural context a resource belongs to. */
export type KnowledgeContext = SharedContext | PrivateWorkContext;

export interface SharedContext {
  kind: "shared";
  id: string;
  projectId: string;
}

export interface PrivateWorkContext {
  kind: "private-work";
  id: string;
  projectId: string;
  ownerUserId: string;
  name: string;
  description?: string;
  lifecycle: "active" | "archived";
  createdAt: Date;
  updatedAt: Date;
}

export const sharedContextId = (projectId: string): string => `shared:${projectId}`;
