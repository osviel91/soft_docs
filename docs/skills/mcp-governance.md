# MCP Knowledge Governance

Use this process for every agent interaction with Software Docs Manager.

## Contexts

- **SHARED** is authoritative project knowledge. Agents may ordinarily read it, but do not mutate it with resource, relationship, or semantic tools.
- **MY WORK** is a private, writable context owned by the current user. Create or discover it with `list_private_work_contexts` and `create_private_work_context`.
- **PROPOSAL** is an immutable submitted snapshot of selected MY WORK. Submission makes intent team-visible, not authoritative.
- **REVIEW** records `APPROVE` or `REQUEST_CHANGES`. Review does not publish.
- **PROMOTION** is the explicit authoritative transition. `PromotionService` revalidates permission, OWNER role, readiness, current preview, and conflicts at execution.

Self-review is governed by workspace policy. `allow_author_self_review` defaults
to `false`; workspace governance can enable author approval. Inspect proposal
capabilities before review, but treat them as advisory: the review use case
rechecks policy, permission, and proposal state.

## Discovery and authority

The remote governed MCP publishes its governance guide as a discoverable reference
resource (`seqdocs://reference/mcp-governance`) and exposes `get_project_capabilities`
for project, private-work context, and proposal targets. Capability reads describe
the observed credential scope, project/workspace authority, ownership, lifecycle,
and readiness; they are not authorization grants. PAT scopes and project roles
both matter, and every application use case rechecks current authority/state at
mutation time (TOCTOU).

The remote governed MCP is an application boundary over shared application
services, not a parallel authorization system. The local-first stdio MCP works
against a local filesystem workspace and has no server SHARED/MY WORK proposal
governance context; use remote MCP for governed server-project workflows.

## Workflow

1. Call `list_projects`, then `get_project` and `list_resources` to inspect the
   selected project and relevant resources.
2. Call `get_project_capabilities`; use structured reasons instead of inferring authority from role names or PAT scopes.
3. Call `list_private_work_contexts`, then create an owned context with `create_private_work_context` when needed.
4. Read relevant SHARED knowledge.
5. Create or edit resources, relationships, and semantic identities in MY WORK with the required `contextId`.
6. Validate, render, and trace as needed.
7. Call `submit_architectural_proposal` explicitly when the user intends to share the snapshot. Submitted proposals are immutable.
8. Inspect the proposal and call `get_project_capabilities` with `proposalId`.
9. Call `review_architectural_proposal` only when the actor is permitted and the user explicitly requests a review decision.
10. Call `preview_architectural_proposal_promotion` before any requested publication.
11. Call `promote_architectural_proposal` only when explicitly requested and the current capability and preview allow it.

To revise, return to the author's active MY WORK, edit privately, then call
`revise_architectural_proposal`. This creates a new immutable snapshot,
supersedes the previous proposal, captures a fresh SHARED base, and never transfers
reviews. The old snapshot is not edited in place. Use
`withdraw_architectural_proposal` for non-destructive withdrawal by the author;
WITHDRAWN and SUPERSEDED proposals cannot be reviewed or promoted. Revision and
withdrawal do not mutate SHARED. Re-read SHARED after promotion to verify the
result.

## Safety Rules

Never:

- write an ordinary resource with omitted or null `contextId`;
- directly mutate a SHARED relationship or semantic identity;
- assume OWNER bypasses the proposal lifecycle;
- assume `resource:write` grants publication;
- assume approval means promoted;
- assume preview means promoted;
- treat promotion readiness as permanent after preview;
- retry a conflict blindly.

`get_project_capabilities` is advisory metadata, not a token or authorization.
This is a TOCTOU boundary: state or permissions can change after the query, and
the authoritative application command may still reject. Promotion has durable
`COMMITTED_COMPLETION_PENDING` / `COMPLETED` evidence; proposal lifecycle reports
the derived `PROMOTING` / `PROMOTED` state. Application recovery completes pending
filesystem/manifest work before completion is reported.

On conflict, re-read SHARED and the proposal/preview, understand the changed base, update or rebase through MY WORK, and resubmit where required. Preserve structured denial reasons such as missing scope, wrong context, not owner, review required, stale proposal, promotion conflict, and legacy resubmit/rebase required.

Tool metadata is discovery guidance only. Application use cases remain the authorization and authoritative-write enforcement point.
