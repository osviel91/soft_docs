import type { ProjectShareGrant } from "../../domain/project/share-grant";
import type { AuditEvent } from "./audit-repository";

export interface ProjectShareRepository {
  create(grant: ProjectShareGrant, audit: AuditEvent): Promise<ProjectShareGrant>;
  list(projectId: string): Promise<ProjectShareGrant[]>;
  find(id: string): Promise<ProjectShareGrant | null>;
  findByToken(id: string, tokenHash: string): Promise<ProjectShareGrant | null>;
  revoke(id: string, actorId: string, audit: AuditEvent): Promise<void>;
}
