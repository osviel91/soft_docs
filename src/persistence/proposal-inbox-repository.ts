import type { ProposalInboxRepository, ProposalInboxItem, ProposalAttentionCategory } from "../application/ports/proposal-inbox-repository";
import type { SqlClient } from "./sql-client";

const categoryList: ProposalAttentionCategory[] = ["PENDING_REVIEW", "CHANGES_REQUESTED", "APPROVED_PENDING_PROMOTION", "PROMOTION_COMPLETION_PENDING", "PROMOTED", "WITHDRAWN", "SUPERSEDED"];

function date(value: unknown): string {
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}

export function createProposalInboxRepository(client: SqlClient): ProposalInboxRepository {
  return {
    async query({ userId, allowedProjectIds, filters, after }) {
      const result = await client.query(
        `WITH authorized AS (
           SELECT ap.id AS proposal_id, ap.project_id, ap.author_user_id, ap.title, ap.status,
                  ap.created_at, ap.submitted_at, ap.withdrawn_at, ap.superseded_at,
                  p.workspace_id, p.name AS project_name, w.name AS workspace_name,
                  u.display_name AS author_display_name
             FROM architectural_proposals ap
             JOIN projects p ON p.id = ap.project_id
             JOIN workspaces w ON w.id = p.workspace_id
             JOIN workspace_members wm ON wm.workspace_id = p.workspace_id AND wm.user_id = $1
             JOIN users u ON u.id = ap.author_user_id
            WHERE ($2::uuid[] IS NULL OR p.id = ANY($2::uuid[]))
              AND ($3::uuid IS NULL OR p.workspace_id = $3::uuid)
              AND ($4::uuid IS NULL OR p.id = $4::uuid)
         ), latest_reviews AS (
           SELECT DISTINCT ON (r.proposal_id, r.reviewer_user_id)
                  r.proposal_id, r.reviewer_user_id, r.decision, GREATEST(r.created_at, r.updated_at) AS activity_at
             FROM architectural_proposal_reviews r
             JOIN authorized a ON a.proposal_id = r.proposal_id
            ORDER BY r.proposal_id, r.reviewer_user_id, r.created_at DESC, r.id DESC
         ), review_summary AS (
           SELECT proposal_id,
                  count(*) FILTER (WHERE decision = 'APPROVE')::int AS approvals,
                  count(*) FILTER (WHERE decision = 'REQUEST_CHANGES')::int AS changes_requested
             FROM latest_reviews GROUP BY proposal_id
         ), review_activity AS (
           SELECT r.proposal_id, max(GREATEST(r.created_at, r.updated_at)) AS activity_at
             FROM architectural_proposal_reviews r
             JOIN authorized a ON a.proposal_id = r.proposal_id
            GROUP BY r.proposal_id
         ), enriched AS (
           SELECT a.*, COALESCE(rs.approvals, 0)::int AS approvals,
                  COALESCE(rs.changes_requested, 0)::int AS changes_requested,
                  CASE WHEN COALESCE(rs.approvals, 0) = 0 AND COALESCE(rs.changes_requested, 0) = 0 THEN 'none'
                       WHEN rs.approvals > 0 AND rs.changes_requested > 0 THEN 'mixed'
                       WHEN rs.approvals > 0 THEN 'approved' ELSE 'changes-requested' END AS review_status,
                  pr.status AS promotion_status, pr.created_at AS promotion_created_at, pr.completed_at AS promotion_completed_at,
                  GREATEST(a.submitted_at, a.withdrawn_at, a.superseded_at, ra.activity_at, pr.created_at, pr.completed_at) AS last_activity_at
             FROM authorized a
             LEFT JOIN review_summary rs ON rs.proposal_id = a.proposal_id
             LEFT JOIN review_activity ra ON ra.proposal_id = a.proposal_id
             LEFT JOIN promotions pr ON pr.project_id = a.project_id AND pr.proposal_id = a.proposal_id
         ), categorized AS (
           SELECT e.*,
             CASE WHEN status = 'withdrawn' THEN 'WITHDRAWN'
                  WHEN status = 'superseded' THEN 'SUPERSEDED'
                  WHEN promotion_status = 'COMPLETED' THEN 'PROMOTED'
                  WHEN promotion_status = 'COMMITTED_COMPLETION_PENDING' THEN 'PROMOTION_COMPLETION_PENDING'
                  WHEN review_status IN ('changes-requested', 'mixed') THEN 'CHANGES_REQUESTED'
                  WHEN review_status = 'approved' THEN 'APPROVED_PENDING_PROMOTION'
                  ELSE 'PENDING_REVIEW' END AS attention_category,
             CASE WHEN status = 'withdrawn' THEN 'WITHDRAWN'
                  WHEN status = 'superseded' THEN 'SUPERSEDED'
                  WHEN promotion_status = 'COMPLETED' THEN 'PROMOTED'
                  WHEN promotion_status = 'COMMITTED_COMPLETION_PENDING' THEN 'PROMOTING'
                  WHEN review_status IN ('changes-requested', 'mixed') THEN 'CHANGES_REQUESTED'
                  WHEN review_status = 'approved' THEN 'APPROVED'
                  ELSE 'OPEN' END AS lifecycle
           FROM enriched e
         ), scoped AS (
           SELECT * FROM categorized c
            WHERE (cardinality($5::text[]) = 0 OR c.status = ANY($5::text[]))
              AND ($6::text IS NULL OR strpos(lower(c.title), lower($6)) > 0)
         ), counts AS (
           SELECT COALESCE(jsonb_object_agg(attention_category, amount), '{}'::jsonb) AS values
             FROM (SELECT attention_category, count(*)::int AS amount FROM scoped GROUP BY attention_category) grouped
         ), page AS (
          SELECT * FROM scoped c
             WHERE (cardinality($7::text[]) = 0 OR c.attention_category = ANY($7::text[]))
               AND ($8::timestamptz IS NULL OR (c.last_activity_at, c.proposal_id) < ($8::timestamptz, $9::uuid))
             ORDER BY c.last_activity_at DESC, c.proposal_id DESC
             LIMIT ($10::int + 1)
          )
          SELECT counts.values AS category_counts, page.*,
                 to_char(page.last_activity_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_activity_at
           FROM counts LEFT JOIN page ON true
          ORDER BY page.last_activity_at DESC NULLS LAST, page.proposal_id DESC NULLS LAST`,
        [userId, allowedProjectIds, filters.workspaceId ?? null, filters.projectId ?? null, filters.status ?? [], filters.search ?? null, filters.attentionCategory ?? [], after?.at ?? null, after?.id ?? null, filters.limit],
      );
      const rows = result.rows;
      const countsData = rows[0]?.category_counts;
      const parsedCounts = (typeof countsData === "string" ? JSON.parse(countsData) : countsData ?? {}) as Record<string, number>;
      const counts = Object.fromEntries(categoryList.map((category) => [category, Number(parsedCounts[category] ?? 0)])) as Record<ProposalAttentionCategory, number>;
      const pageRows = rows.filter((row) => row.proposal_id !== null && row.proposal_id !== undefined);
      const hasMore = pageRows.length > filters.limit;
      const items = pageRows.slice(0, filters.limit).map((row): ProposalInboxItem => ({
        proposalId: String(row.proposal_id),
        title: String(row.title),
        status: row.status as ProposalInboxItem["status"],
        author: { userId: String(row.author_user_id), displayName: row.author_display_name == null ? null : String(row.author_display_name) },
        workspace: { id: String(row.workspace_id), name: String(row.workspace_name) },
        project: { id: String(row.project_id), name: String(row.project_name) },
        createdAt: date(row.created_at),
        submittedAt: date(row.submitted_at),
        lastActivityAt: date(row.last_activity_at),
        review: { status: row.review_status as ProposalInboxItem["review"]["status"], approvals: Number(row.approvals), changesRequested: Number(row.changes_requested) },
        promotion: { status: row.promotion_status == null ? null : row.promotion_status as ProposalInboxItem["promotion"]["status"], createdAt: row.promotion_created_at == null ? null : date(row.promotion_created_at), completedAt: row.promotion_completed_at == null ? null : date(row.promotion_completed_at) },
        lifecycle: row.lifecycle as ProposalInboxItem["lifecycle"],
        attentionCategory: row.attention_category as ProposalAttentionCategory,
      }));
      const last = items.at(-1);
      return {
        items,
        counts,
        hasMore,
       nextPosition: hasMore && last ? { at: String(pageRows[filters.limit - 1]?.cursor_activity_at), id: last.proposalId } : null,
      };
    },
  };
}
