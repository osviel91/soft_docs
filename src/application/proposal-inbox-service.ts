import { createHmac, timingSafeEqual } from "node:crypto";
import { credentialGrants } from "./authorization";
import { forbidden, invalid } from "./errors";
import type { ApplicationContext } from "./context";
import type {
  ProposalAttentionCategory,
  ProposalInboxFilters,
  ProposalInboxRepository,
  ProposalInboxStatus,
} from "./ports/proposal-inbox-repository";

const categories: ProposalAttentionCategory[] = [
  "PENDING_REVIEW",
  "CHANGES_REQUESTED",
  "APPROVED_PENDING_PROMOTION",
  "PROMOTION_COMPLETION_PENDING",
  "PROMOTED",
  "WITHDRAWN",
  "SUPERSEDED",
];
const statuses: ProposalInboxStatus[] = ["open", "withdrawn", "superseded"];

export interface ProposalInboxQuery extends Omit<ProposalInboxFilters, "limit"> {
  limit?: number;
  cursor?: string;
}

export function createProposalInboxService(options: {
  repository: ProposalInboxRepository;
  cursorSecret: string;
}) {
  const sign = (value: string) => createHmac("sha256", options.cursorSecret).update(`proposal-inbox-cursor:${value}`).digest("base64url");
  const filterKey = (filters: ProposalInboxFilters, context: ApplicationContext) => JSON.stringify({
    filters: { ...filters, limit: undefined },
    userId: context.principal.subjectUserId,
    allowedProjectIds: context.principal.allowedProjectIds?.length ? [...context.principal.allowedProjectIds].sort() : null,
  });
  return {
    async list(context: ApplicationContext, query: ProposalInboxQuery) {
      if (!credentialGrants(context.principal, "project:read")) {
        throw forbidden("This credential does not carry the project:read permission.");
      }
      const limit = query.limit ?? 50;
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw invalid("limit must be an integer from 1 to 100.");
      const status = query.status?.length ? [...new Set(query.status)] : undefined;
      if (status?.some((value) => !statuses.includes(value))) throw invalid("status contains an unsupported proposal state.");
      const attentionCategory = query.attentionCategory?.length ? [...new Set(query.attentionCategory)] : undefined;
      if (attentionCategory?.some((value) => !categories.includes(value))) throw invalid("attentionCategory contains an unsupported value.");
      if ([query.workspaceId, query.projectId].some((value) => value !== undefined && !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value))) throw invalid("workspaceId and projectId must be UUIDs.");
      const search = query.search?.trim();
      if (search && search.length > 200) throw invalid("search must be 200 characters or fewer.");
      const filters: ProposalInboxFilters = {
        ...(query.workspaceId ? { workspaceId: query.workspaceId } : {}),
        ...(query.projectId ? { projectId: query.projectId } : {}),
        ...(status ? { status } : {}),
        ...(attentionCategory ? { attentionCategory } : {}),
        ...(search ? { search } : {}),
        limit,
      };
      let after: { at: string; id: string } | undefined;
      if (query.cursor !== undefined) {
        const [encoded, signature, extra] = query.cursor.split(".");
        if (!encoded || !signature || extra !== undefined) throw invalid("cursor is invalid.");
        const expected = sign(encoded);
        const suppliedBytes = Buffer.from(signature);
        const expectedBytes = Buffer.from(expected);
        if (suppliedBytes.length !== expectedBytes.length || !timingSafeEqual(suppliedBytes, expectedBytes)) throw invalid("cursor is invalid.");
        let decoded: unknown;
        try { decoded = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")); } catch { throw invalid("cursor is invalid."); }
         const value = decoded as { v?: unknown; at?: unknown; id?: unknown; filterKey?: unknown };
         if (value.v !== 1 || typeof value.at !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(value.at) || !Number.isFinite(Date.parse(value.at)) || typeof value.id !== "string" || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value.id) || value.filterKey !== filterKey(filters, context)) throw invalid("cursor does not match these filters.");
        after = { at: value.at, id: value.id };
      }
      const result = await options.repository.query({
        userId: context.principal.subjectUserId,
        allowedProjectIds: context.principal.allowedProjectIds?.length ? context.principal.allowedProjectIds : null,
        filters,
        ...(after ? { after } : {}),
      });
      return {
        items: result.items,
        counts: result.counts,
        nextCursor: result.hasMore && result.nextPosition ? proposalInboxCursor(options.cursorSecret, { ...result.nextPosition, filterKey: filterKey(filters, context) }) : null,
      };
    },
  };
}

export function proposalInboxCursor(secret: string, value: { at: string; id: string; filterKey: string }): string {
  const encoded = Buffer.from(JSON.stringify({ ...value, v: 1 })).toString("base64url");
  const signature = createHmac("sha256", secret).update(`proposal-inbox-cursor:${encoded}`).digest("base64url");
  return `${encoded}.${signature}`;
}
