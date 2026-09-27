import type { Promotion } from "../../domain/workspace/promotion";

export interface PromotionRepository {
  get(projectId: string, promotionId: string): Promise<Promotion | null>;
  getForProposal(projectId: string, proposalId: string): Promise<Promotion | null>;
  listForResource(projectId: string, resourceId: string): Promise<Promotion[]>;
  listIncomplete(projectId?: string): Promise<Promotion[]>;
  complete(promotionId: string): Promise<void>;
}
