# Architecture Inbox: Personalized Attention Design

Status: overall personalized-attention design. Increment 1 is implemented locally. Later increments remain proposed and require separate approval.

This document contains both implemented scope and future design. Only Increment 1 below is implemented: the Inbox exposes the authenticated subject's latest effective review, clarifies global governance terminology, and labels persisted activity timestamps. Personalized attention views, per-row action capabilities, assignment, notifications, unread/read state, alternate prioritization, and activity feeds are not implemented by this increment.

### Increment 1 delivered

- `myReview` is `null` or the latest effective review for `context.principal.subjectUserId`, with its decision and persisted timestamps. It is selected in the existing Inbox query and does not alter aggregate review state.
- The UI shows the user's own decision separately from global proposal state and keeps submission/review/promotion activity labels tied to persisted timestamps.
- No new endpoint, query parameter, migration, assignment, read-state, notification, authorization-policy, governance, Review, Promotion, or roadmap-phase change was made.
- Focused persistence, API isolation, client contract, UI, and workspace navigation tests cover the increment. Full local verification results are recorded in the implementation report, not treated as deployed acceptance.

Everything else in this document is a design proposal, not an approved implementation plan.

## Scope and evidence

Inspected the proposal domain/service, review and promotion services/repositories, authorization/capability services, Inbox port/service/SQL/UI/API client, migrations 0017, 0018, 0021 and 0025, related Inbox tests, and the current Software Docs project resources and roadmap. The code references below are the verification anchors. The project knowledge inspection found the governed-publication sequence and overview, but no dedicated Inbox resource. The project roadmap says D03.15–D03.19 continue under existing contracts; this design does not assign or reinterpret those stages.

Relevant implementation: `src/domain/workspace/architectural-proposal.ts`, `src/application/architectural-proposal-service.ts`, `src/application/promotion-service.ts`, `src/application/capability-service.ts`, `src/application/authorization.ts`, `src/domain/access/permissions.ts`, `src/application/ports/proposal-inbox-repository.ts`, `src/application/proposal-inbox-service.ts`, `src/persistence/proposal-inbox-repository.ts`, `src/features/proposals/ArchitectureInbox.tsx`, `apps/api/routes.ts`, and `src/workspace/server/api-client.ts`.

## 1. Existing capabilities

### Proposal, review and promotion state

- Persisted `ArchitecturalProposal.status` is `open | withdrawn | superseded`. Open is not synonymous with waiting for this particular viewer.
- Derived lifecycle is `OPEN | CHANGES_REQUESTED | APPROVED | PROMOTING | PROMOTED | WITHDRAWN | SUPERSEDED`. The Inbox derives it from proposal status, latest effective review per reviewer, and persisted promotion evidence.
- Review evidence is append-only: reviewer user ID, decision (`APPROVE` or `REQUEST_CHANGES`), optional summary, creation/update timestamps, proposal base revision and observed SHARED revision. The effective decision for an aggregate is the most recent review per reviewer; all evidence remains available in history. `mixed` is possible and blocks promotion.
- Promotions are persisted separately. Their status is `COMMITTED_COMPLETION_PENDING | COMPLETED`, with creation and completion timestamps. Recovery can complete pending authoritative batches.
- Proposal snapshots are immutable. Revising creates a successor and marks the previous proposal `superseded`; a change to a submitted proposal therefore appears as a successor, not a new revision of the same Inbox item.

### Current Inbox and activity

The current exclusive categories are `PENDING_REVIEW`, `CHANGES_REQUESTED`, `APPROVED_PENDING_PROMOTION`, `PROMOTION_COMPLETION_PENDING`, `PROMOTED`, `WITHDRAWN`, `SUPERSEDED`. `NEEDS_ATTENTION` is a UI filter over the first four, not a persisted/domain category. The list is currently ordered by `lastActivityAt DESC, proposalId DESC` and uses signed keyset pagination.

The item exposes `createdAt`, `submittedAt`, `lastActivityAt`, aggregate effective review status/counts, promotion status/created/completed dates and proposal lifecycle. Increment 1 adds `myReview` for the authenticated subject. `lastActivityAt` is the maximum available submission, withdrawal, supersession, review creation/update, promotion creation and completion timestamp. It is aggregate activity, not activity since the current user's visit. Review timestamps and review history allow identifying new review records and effective-decision changes; they do not provide a personal read baseline. Proposal creation/submission time, not an inferred event, is the evidence for a new proposal. Promotion timestamps support recent-promotion labels.

`architectural_proposal_reviews` has no assignment, read receipt, or notification delivery fields. There is no proposal assignee concept, Inbox read-state table, per-user `lastReadAt`, or endpoint/UI mutation for recording reads. `promotions` provides durable action and completion timestamps, but no separate per-viewer activity feed. Do not imply historical activity not represented by these records.

### Visibility, permissions and identity

- Inbox visibility is currently scoped by live workspace membership and, for restricted credentials, allowed project IDs; project/workspace/search/status/category filters narrow that set. The Inbox list use case requires the credential's `project:read` scope. Proposal-specific writes still go through authorization and operation services.
- Effective project permissions combine project role and credential scopes. OWNER has `promotion:execute`; EDITOR can update/review resources but is not a promoter by default; VIEWER is read-only. Workspace ADMIN governance can override selected governance operations only when the caller can read the project and the credential carries the required permission. Self-review policy can deny an author review.
- The authenticated subject is `context.principal.subjectUserId`. Session identity is resolved at the API edge; a user-facing Inbox must not accept a client-supplied user ID as the authorization identity. Agent credentials remain scoped by owner authority, scopes and optional allowed-project restrictions.
- Proposal capabilities are advisory and proposal-specific: review, revise, withdraw, preview promotion and promote. They can include policy and readiness reasons; every operation rechecks current authorization/state. `proposal.promote` currently invokes a promotion preview and can have blockers beyond permission.

## 2. Uncovered needs

1. The UI now shows the signed-in subject's latest review evidence, but still does not expose exact review/promotion capabilities for each row.
2. `PENDING_REVIEW` is a global lifecycle fact. It cannot establish an obligation assigned to this user, nor that a reviewer owes a decision.
3. There is no distinction in the list between an action being allowed, an action being pending in global governance, and a recommendation to act.
4. “Reviewed by me, then changed” has no normal same-proposal trigger because proposal snapshots are immutable. A successor is a new proposal; a prior review on its predecessor is historical context, not a review of the successor. Review records also capture observed SHARED revision, which may differ from current SHARED, but the Inbox does not currently expose that freshness comparison.
5. Recent activity is queryable in aggregate, but “new since my last visit” is not. `last_seen_at` on a session is session activity, not Inbox read state.
6. Promotion pending completion is global operational work, but user capability does not mean the user owns the recovery task. Recovery is a service operation, not a per-user assignment.

## 3. Proposed attention rules

Use separate dimensions; do not overload one category with authorization, workflow state, and recommendation.

- **Governance state**: preserve current lifecycle/category meanings and precedence.
- **Action allowed**: a current, user-specific capability decision for a named operation. This is authorization/readiness, not an obligation. It may change between list and click; mutation routes remain authoritative.
- **Action pending**: a fact about the workflow, not the current subject. Examples: at least one explicit effective approval is missing under an approved quorum policy; a review request exists; promotion evidence is committed but incomplete. Existing policy currently requires an explicit approval and no effective change request for promotion, but does not define a review quorum or an individual reviewer obligation. Until a quorum/obligation policy is approved, call open `none`/`changes-requested` cases “review available” or “review state unresolved”, not “you owe a review”.
- **Action recommended**: UI guidance derived from state plus allowed capability. Recommended does not claim assignment or urgency. Suggested order: if the subject can review an open proposal and their effective decision is absent or `REQUEST_CHANGES`, offer “Review” as a recommendation; if they have a recorded review, show “Your decision: …” and allow changing it only when server capability says review is permitted. For an approved proposal, promote only if current `proposal.promote` is allowed; otherwise show the blocking reason and “follow up” where appropriate. Do not recommend promotion just because global status is approved.
- **Action assigned**: absent in the current domain. Do not show “assigned to me” or “my reviews” as assigned work. If explicit assignment is later approved, define its ownership, reassignment, audit, and authorization semantics as a separate feature.
- **Reviewed then changed**: no such same-snapshot state is implied. Optionally show a lineage hint when a proposal supersedes one on which the subject reviewed, using existing `supersedesProposalId` and review identity evidence. Keep it informational, not an automatic carry-over task.
- **Recent activity**: expose real timestamps and typed activity facts (submission, review evidence, promotion creation/completion, lifecycle transition) only where present. Avoid a synthetic activity timestamp or asserting a decision “changed” unless review history proves the preceding effective decision differs.

Recommended initial views are **Needs my decision** (open, review capability allowed, effective decision by this user absent or `REQUEST_CHANGES`), **Promotion available to me** (globally approved and promote capability currently allowed), **Following** (all other visible proposals requiring awareness, including pending completion, blocked approval, and terminal states), and **All**. These are derived views, not assignments. Keep a global governance-state filter for compatibility. Do not label `COMMITTED_COMPLETION_PENDING` as an action allowed to the viewer; indicate system follow-up and provide a status/details link.

## 4. State, permissions and action matrix

| Governance state | User-specific evidence/capability | Pending fact | Recommended presentation |
| --- | --- | --- | --- |
| Open, no effective reviews | Review allowed; own latest decision absent | Review evidence absent globally | “Review available”; enter Needs my decision only if the product accepts capability as a suggestion, not an assigned obligation |
| Open, some approvals | Review allowed; own latest decision absent | Global approval exists, but quorum/remaining-review obligation is unspecified | “Review available”; do not say “awaiting your review” |
| Open, changes requested or mixed | Review allowed; own decision may be absent or latest request-changes | Effective change request remains; exact resolution policy depends on reviewer decisions | “Changes requested”; recommend inspect/review if allowed |
| Open, subject has effective approval | Subject has already reviewed | No individual pending decision established | “Your decision: approved”; keep in All/Following, not Needs my decision by default |
| Approved, no promotion record | `proposal.promote` allowed or denied with reason | Promotion eligibility is global; current preview can still find stale/conflict blockers | Recommend promotion only when current preview/capability is eligible; otherwise show blocker/follow-up |
| Promotion completion pending | May or may not have promotion permission | Durable completion task exists; not assigned to viewer | “Completion pending”; operational/system follow-up, never personal ownership |
| Promoted | Read capability | No governance action pending | Show completed and promotion timestamps; optionally recent |
| Withdrawn/superseded | Read capability; lifecycle actions are unavailable | Terminal proposal state | Follow/history only; successor link if present |

For every row, `allowed` is separate from `pending` and `recommended`. An authorization denial is not evidence that someone else is assigned. Current exact action decisions come from server use cases/capability service, never client role guesses. Capability results are advisory and can race; operation responses remain authoritative.

## 5. API and read model

### Compatibility-first contract

**Implemented in Increment 1:** `GET /api/inbox/proposals` retains its existing query contract and adds `myReview` to each item. It is `null` or `{ decision, createdAt, updatedAt }`; the subject comes only from authenticated application context. The API client validates the field and normalizes a legacy response without it to `null`.

**Proposed, not implemented:** add optional query `attentionView=needs_my_decision|promotion_available_to_me|following|all`; retain `attentionCategory` as the existing global category filter. If both are supplied, document that they compose as intersection, or reject the ambiguous combination; recommendation is reject with 400 for an explicit, predictable filter contract.

The following extended fields are future design examples only; Increment 1 adds none of them:

```json
{
  "myReview": {
    "decision": "APPROVE",
    "createdAt": "...",
    "updatedAt": "..."
  },
  "actions": {
    "review": { "allowed": true, "reason": null },
    "promote": { "allowed": false, "reason": "review_required" }
  },
  "attention": {
    "view": "following",
    "recommendation": "follow_up"
  }
}
```

This is illustrative; the API should omit `assigned` rather than ship a constant if no assignment feature exists. Prefer field names such as `suggestedAction` over a boolean “assigned”. `reason` values should reuse stable capability reasons/blocker codes where possible; distinguish “permission denied” from “governance not ready”. Do not include a client-supplied subject identifier.

`myReview` is implemented as the latest review for `context.principal.subjectUserId`. The current effective aggregate remains unchanged and useful to all viewers. A separate “activity” object should be considered only if the UI actually renders typed events; do not add a second event store solely to repeat existing timestamps.

### Authorization and evaluation cost

Continue list authorization and membership/project restriction exactly as today. Resolve the authenticated principal once in the API context. Compute own-review evidence in the read query using an exact reviewer-user-ID predicate. For permission facts, do not reproduce policy rules in SQL or infer from role labels in React. Preferred first increment: add `myReview` and low-cost state-derived recommendations to the Inbox projection; expose exact actions on proposal detail using the existing capability endpoint/service. To filter “Needs my decision” exactly without N per-row capability requests, add a batched application read-model operation that resolves effective review/actionability for the candidate project set through the AuthorizationPolicy/CapabilityService boundary, with repository joins batched by distinct project. Do not issue per-item `proposal()` calls (which currently preview promotion) for every Inbox row.

If exact per-row allowed actions are included in the list, the application layer must batch role/scope/workspace-admin/self-review checks and avoid promotion preview work for non-approved rows. Approved-row eligibility may require plan/blocker evaluation; consider returning `promote.allowed` only for detail initially and mark list-level “promotion available” as a state recommendation until exact readiness can be computed efficiently. UI must label that distinction.

### Filtering, sorting, counts and pagination

- Define `counts` for current filters before the selected attention view/category, as the existing repository does for category chips. Add clearly named view counts only after all view predicates are exact and can be computed in the same query/snapshot.
- Return per-page `myReview` and derived view predicates from the same repository snapshot used for the page. Avoid separate count/page reads that disagree during writes.
- Preserve stable keyset pagination. If sort remains `lastActivityAt DESC, proposalId DESC`, maintain the matching tuple cursor; bind cursor signature to user subject, allowed project IDs and all filters including `attentionView`.
- Deterministic priority without false urgency: first bucket by actionable recommendation (Needs my decision, promotable, follow-up, informational), then global governance state, then activity time descending, then submission time ascending (older submission first within a state/activity tie), then proposal ID. No numeric urgency score, SLA, or “overdue” claim without an approved policy and source timestamps. This alternative changes the cursor sort tuple and should be versioned; simpler V1 can retain current activity order and add a separate attention-view selection, then change sorting only with explicit UX approval.
- Bound page size as today (1–100, default 50). Add indexes only after `EXPLAIN (ANALYZE, BUFFERS)` on representative workspace/project/reviewer distributions demonstrates need. Existing Inbox test checks one-query execution and an analyzed 1,000-proposal plan; extend it rather than introducing premature denormalization.

## 6. UI changes

- Preserve existing workspace/project/search/category filters and deep links; add a view selector whose labels explicitly say “Needs my decision” / “Promotion available to me” / “Following”, not “Assigned to me”.
- Distinguish global status from personal recommendation and action availability. Render “You can review” separately from “Changes requested”; render a denial/blocker reason without implying responsibility.
- **Implemented in Increment 1:** show “Your latest decision” from `myReview` with its persisted timestamp; preserve aggregate review counts and promotion status/date. Label existing aggregate activity as “Last activity”.
- **Not implemented:** personalized action views, per-row capabilities, “New since last visit”, or event timelines. Any future activity UI must use persisted facts; “New since last visit” requires a separate read-state decision below.
- Keep keyboard access, visible focus, responsive list behavior, empty/loading/error states, and existing return-to-filter behavior.

## 7. Activity since last visit: alternatives and cost

1. **No read persistence (recommended V1):** use `lastActivityAt` and real typed timestamps, optionally let users sort/filter a bounded recent window. Lowest complexity; does not claim unseen/new-for-me.
2. **Per-user Inbox watermark:** persist `(user_id, scope, last_seen_at)` and update when Inbox is opened or a view is marked read. Cheap storage and query, but a watermark is not per-proposal read state; background updates can hide activity the user never saw, and defining workspace/project/filter scope is necessary. Prefer explicit “Mark all read” semantics if chosen.
3. **Per-user proposal receipts:** persist `(user_id, proposal_id, last_read_activity_at)` and update on explicit open/mark-read. Precise per-proposal unread state, but requires migration, read/write endpoint, authorization, cleanup/retention, race-safe comparison against `lastActivityAt`, and additional joins/count work. Read state must not be confused with review evidence.
4. **Activity event feed:** introduce durable typed events and per-user cursors only if audit/feed semantics are needed beyond current proposal/review/promotion evidence. Highest cost and migration scope; current records suffice for basic “recent activity” and should not be duplicated speculatively.

No alternative can reconstruct historical “last visit” values retroactively. Start with option 1; obtain product approval before persistence.

## 8. Risks and alternatives

- **False assignment/urgency:** the highest UX risk. Mitigate with exact vocabulary, no assignee inference, and no numeric score/SLA.
- **Capability drift/TOCTOU:** list-level actions can go stale. Keep operation-time checks and detail revalidation; never treat Inbox output as authorization.
- **Policy ambiguity:** review quorum and what constitutes a fulfilled review obligation are not modeled. Do not introduce “pending for you” until an explicit governance policy is decided.
- **N+1 authorization/preview:** per-row capability service invokes multiple checks and can build a promotion plan. Batch only what is needed; keep detailed readiness on the proposal page initially.
- **Activity ambiguity:** `updatedAt` exists on reviews, but the migration describes append-only review evidence. Use evidence insertion chronology as a new decision; only call it a changed decision when comparing successive rows for the same reviewer. Do not assume proposal snapshots mutate.
- **Read-state privacy/storage:** read receipts expose viewing behavior and create retention/deletion requirements. Add only with a clear user benefit and privacy decision.
- **Order instability:** activity changes between page requests can move rows across a cursor. Existing keyset pagination has this normal live-feed property; document it and keep tie-breakers. Snapshot pagination would cost more and is not recommended for V1.
- **Large global scope:** current one-query CTE and counts may become costly as review histories grow. Verify real plans and data cardinalities before adding caches, materialized state, or indexes.
- **Workspace administrator override and restricted credentials:** tests must cover permission/scope combinations and ensure filtered results never leak projects beyond allowed IDs.

## 9. Incremental plan and verification

1. **Increment 1 — implemented locally:** additive `myReview`, clear personal/global labels, persisted activity labels, and focused query/API/UI/navigation tests. Existing filters, categories, counts, order and cursor remain unchanged.
2. **Personalized action views — pending approval:** add `attentionView` only after governance/product approves exact rules and the server can evaluate them without N+1 preview calls. Test owner/editor/viewer, scopes, workspace ADMIN override, author self-review policy, mixed decisions, and promotion blockers.
3. **Priority and counts — pending approval:** decide whether to retain current activity order or adopt the proposed lexicographic order. Test exact tie-breaks, microsecond cursor precision, all filters bound to cursor, counts under category/view filters, and concurrent activity semantics.
4. **Read state (optional; pending approval):** choose watermark or proposal receipts only after deciding scope, write trigger, privacy/retention and reset behavior. Add API, migration and race tests then; do not make it a prerequisite for useful personalized suggestions.
5. **Performance follow-up:** extend the existing 1,000-proposal query-plan test with reviewer history and multiple projects if measurements justify it; assert no per-item query pattern and add indexes only when plans show need. A larger benchmark is optional if ordinary CI runtime remains acceptable.

Future implementation steps should keep use-case authorization in application services, query/persistence shaping in the Inbox repository, transport parsing in API routes, and presentation in the existing Inbox feature. Validate live permission at the action endpoint. The Increment 1 code is local application implementation; this design document itself makes no application changes.

## 10. Decisions requiring approval

1. Is review merely available to any eligible reviewer, or does policy create an actual per-reviewer obligation/quorum? Until decided, do not state “pending for you”.
2. Should the Inbox recommend review to eligible users who have not reviewed, or only show their capability neutrally?
3. Should `REQUEST_CHANGES` count as a decision already made (default recommendation: yes), or should the reviewer remain in a personal attention view until another decision is recorded?
4. Is “promotion available to me” exact readiness (including current blockers) required in list filtering, or is a state-based suggestion with detail-page preview acceptable for V1?
5. Which initial views and default are desired, and should the old `NEEDS_ATTENTION` shortcut map unchanged to the four existing global categories?
6. Keep current activity-first ordering, or approve lexicographic action/state/activity/age priority? Do not add an opaque numerical score.
7. Is per-user read/unread worth persistence? If yes, choose watermark vs per-proposal receipts, read trigger/scope, privacy and retention.
8. Should activity use a separate typed timeline response, or are existing `lastActivityAt`, review evidence and promotion timestamps sufficient for V1?
9. Is explicit reviewer assignment a product need? It must be designed as a domain feature and not inferred from visibility, role, past reviews, or capability.

## Architectural artifact scope

No SHARED, MY WORK, proposal, or roadmap phase assignment was changed for Increment 1. The current shared architecture documents governed proposal/review/promotion, but not the Inbox query/read-model flow. If a future architecture-documentation change is authorized, update MY WORK first and include an evidence-backed Sequence for API Inbox query -> authenticated subject/read model -> persistence -> UI. Update the Database artifact only if a user-read/assignment table is later approved; update the Conceptual artifact only if assignment or attention becomes a durable domain concept. No Event Flow is warranted: the inspected Inbox is synchronous query/UI behavior and no asynchronous event cause/effect chain was observed. Submit or publish no artifact without explicit authorization.
