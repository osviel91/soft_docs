# MCP Knowledge Governance

Use this process for every agent interaction with Software Docs Manager.

## Contexts

- **SHARED** is authoritative project knowledge. Agents may ordinarily read it, but do not mutate it with resource, relationship, or semantic tools.
- **MY WORK** is a private, writable context owned by the current user. Create or discover it with `list_private_work_contexts` and `create_private_work_context`.
- **PROPOSAL** is an immutable submitted snapshot of selected MY WORK. Submission makes intent team-visible, not authoritative.
- **REVIEW** records `APPROVE` or `REQUEST_CHANGES`. Review does not publish.
- **PROMOTION** is the explicit authoritative transition. `PromotionService` revalidates permission, OWNER role, readiness, current preview, and conflicts at execution.

Proposal authors cannot approve their own proposals. Inspect proposal target capabilities before attempting review; capability results are advisory and the review command rechecks this invariant.

## Workflow

1. Call `list_projects` and inspect the project.
2. Call `get_project_capabilities`; use structured reasons instead of inferring authority from role names or PAT scopes.
3. Call `list_private_work_contexts`, then create an owned context with `create_private_work_context` when needed.
4. Read relevant SHARED knowledge.
5. Create or edit resources, relationships, and semantic identities in MY WORK with the required `contextId`.
6. Validate, render, and trace as needed.
7. Call `submit_architectural_proposal` explicitly when the user intends to share the snapshot. Submitted proposals are immutable.
8. Inspect the proposal and call `get_project_capabilities` with `proposalId`.
9. Call `preview_architectural_proposal_promotion` before any requested publication.
10. Call `review_architectural_proposal` only when the actor is permitted and the user explicitly requests a review decision.
11. Call `promote_architectural_proposal` only when explicitly requested and the current capability and preview allow it.

To revise, return to the author's active MY WORK, edit privately, then call `revise_architectural_proposal`. This creates a new immutable snapshot, supersedes the previous proposal, captures a fresh SHARED base, and never transfers reviews. Use `withdraw_architectural_proposal` for non-destructive withdrawal by the author; WITHDRAWN and SUPERSEDED proposals cannot publish. Revision and withdrawal do not mutate SHARED. Capabilities are advisory and commands revalidate current state.
12. Re-read SHARED to verify the result.

## Safety Rules

Never:

- write an ordinary resource with omitted or null `contextId`;
- directly mutate a SHARED relationship or semantic identity;
- assume OWNER bypasses the proposal lifecycle;
- assume `resource:write` grants publication;
- assume approval means promoted;
- assume preview means promoted;
- retry a conflict blindly.

`get_project_capabilities` is advisory metadata, not a token or authorization. This is a TOCTOU boundary: state or permissions can change after the query, and the authoritative command may still reject.

On conflict, re-read SHARED and the proposal/preview, understand the changed base, update or rebase through MY WORK, and resubmit where required. Preserve structured denial reasons such as missing scope, wrong context, not owner, review required, stale proposal, promotion conflict, and legacy resubmit/rebase required.

Tool metadata is discovery guidance only. Application use cases remain the authorization and authoritative-write enforcement point.
