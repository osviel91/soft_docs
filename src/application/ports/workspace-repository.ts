import type {
  ServerWorkspace,
  WorkspaceMember,
  WorkspaceRole,
} from "../../domain/workspace/server-workspace";

export interface WorkspaceRepository {
  create(input: { ownerId: string; name: string }): Promise<ServerWorkspace>;
  rename(
    workspaceId: string,
    name: string,
    userId: string,
  ): Promise<ServerWorkspace>;
  delete(workspaceId: string): Promise<void>;
  listForUser(userId: string): Promise<ServerWorkspace[]>;
  listAll(userId: string): Promise<ServerWorkspace[]>;
  authorSelfReviewAllowed(workspaceId: string): Promise<boolean>;
  setAuthorSelfReviewAllowed(workspaceId: string, allowed: boolean): Promise<void>;
  listMembers(workspaceId: string): Promise<WorkspaceMember[]>;
  roleOf(workspaceId: string, userId: string): Promise<WorkspaceRole | null>;
  setMember(
    workspaceId: string,
    userId: string,
    role: WorkspaceRole,
  ): Promise<WorkspaceMember>;
  removeMember(workspaceId: string, userId: string): Promise<void>;
}
