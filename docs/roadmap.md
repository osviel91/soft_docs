# Roadmap

This roadmap separates implementation, verification, and external acceptance.
It is a direction and evidence record, not a delivery schedule. `IMPLEMENTED`
means the capability exists in the repository; `FUNCTIONALLY VERIFIED` means
repository tests or checks exercise it; `EXTERNALLY ACCEPTED` means an external
pilot or production scenario was explicitly exercised. These dimensions coexist
and are not a single completion flag.

## Current baseline

| Phase | Capability | Implementation | Evidence | Pending limitations / next step |
| --- | --- | --- | --- | --- |
| D03.0–D03.2 | Semantic linking foundation, typed anchors/bindings, authoring and navigation | IMPLEMENTED | `docs/d03-0-cross-artifact-semantic-linking.md`, `docs/d03-1-semantic-binding-core-decisions.md`, `docs/d03-2-semantic-binding-authoring-navigation-status.md`; binding query, panel, MCP and persistence tests | External acceptance is not asserted here. |
| D03.3.1–D03.3.4 | Candidate discovery, private assessment, API/MCP and UI workspace | IMPLEMENTED; FUNCTIONALLY VERIFIED; PARTIALLY VERIFIED externally | `docs/d03-3-candidate-discovery-assessment-design.md`; domain, application, persistence, API, MCP and `SemanticBindingsPanel` tests; external observations recorded there | Focused MCP entity/binding queries and read-only zero-result diagnosis now expose exact anchors and active-binding exclusions without changing policy. External checks report BillingMiddleware discovery, pagination, private assessment and optimistic revision; Data Transactions Consumer still requires exercising the diagnostic against the real project. `CURRENT` is freshness, not semantic certainty. |
| D03.4 | Rector contract and exact capability boundary not found | PARTIALLY VERIFIED | Event Flow language/domain/renderer code and tests exist, but current documentation/history does not map them specifically to D03.4 | Recover the original contract/evidence before assigning phase acceptance. |
| D03.5 | Rector contract and exact capability boundary not found | PARTIALLY VERIFIED | Event Flow language/domain/renderer code and tests exist, but current documentation/history does not map them specifically to D03.5 | Recover the original contract/evidence before assigning phase acceptance. |
| D03.6 | Visual label readability | IMPLEMENTED; FUNCTIONALLY VERIFIED | `57e355d`; language/layout/renderer and visual tests | No phase-specific external acceptance evidence found. |
| D03.7 | Complementary-view relationships | IMPLEMENTED; FUNCTIONALLY VERIFIED | `docs/d03-0-cross-artifact-semantic-linking.md`; typed relationship domain, project index and relationship tests; `df5b844` exposes relationships through remote MCP | Relationship means complementary projections, not shared message identity. External acceptance not established. |
| D03.8 | Rich Event Flow entity context | IMPLEMENTED; FUNCTIONALLY VERIFIED | `0f78f42`; Event Flow parser/model/index and related tests | No phase-specific external acceptance evidence found. |
| D03.9 | Live workspace state and viewer UX | IMPLEMENTED; FUNCTIONALLY VERIFIED | `197aa3b`; workspace and viewer integration tests; subsequent UX fixes | Later UX polish does not reopen the underlying phase. No external acceptance evidence found. |
| D03.10 | Failure and retry semantics | IMPLEMENTED; FUNCTIONALLY VERIFIED | `0ba3044`; Event Flow language/domain/validation and retry behavior tests | Unknown policy remains explicit; no external acceptance evidence found. |
| D03.11 | Semantic message identity, authoring and navigation | IMPLEMENTED; FUNCTIONALLY VERIFIED | `docs/documentation-model.md`; `bf975ac`, `1245163`, `ec24913`, `3a7acb0`; semantic-message, binding, trace and UI tests | Equal names remain candidates. Broader external acceptance is not established. |
| D03.12 | Bounded architecture trace domain, MCP and explorer | IMPLEMENTED; FUNCTIONALLY VERIFIED | `819db02`, `4c56927`, `fae5c26`; `tests/domain/project/architecture-trace.test.ts`, MCP transport and `TraceExplorer` tests | Bounded explicit trace is not general impact analysis. |
| D03.13.1 | Dual viewer foundation | IMPLEMENTED; FUNCTIONALLY VERIFIED | `192cdd4`; viewer tests | No phase-specific external acceptance evidence found. |
| D03.13.2 | Semantic comparison and synchronization | IMPLEMENTED; FUNCTIONALLY VERIFIED | `e64731b`; `tests/features/preview/semantic-comparison.test.ts` | Later UX refinement is not phase reopening. |
| D03.13.2.1 | Comparison workspace UX refinement | IMPLEMENTED; FUNCTIONALLY VERIFIED | `90a9226`; comparison UI tests | UX refinement, not a new semantic capability. |
| D03.13.3 | Cross-context architectural analysis | IMPLEMENTED; FUNCTIONALLY VERIFIED | `54c1d0d`; `tests/features/preview/cross-context-analysis.test.ts` | Bounded explicit analysis, not general impact analysis. |
| D03.13.4 | Resizable architectural analysis surface | IMPLEMENTED; FUNCTIONALLY VERIFIED | `b871727`; analysis workspace UI tests | No phase-specific external acceptance evidence found. |
| D03.13.5 | Workspace Explorer foundation | IMPLEMENTED; FUNCTIONALLY VERIFIED | `7a9722e`; explorer tests | Later UX refinements do not reopen delivered capability. |
| D03.13.6 | Unified Workspace Explorer UX | IMPLEMENTED; FUNCTIONALLY VERIFIED | `9ca5498`; explorer tests | UX refinement, not a reopened analysis phase. |
| D03.13.7 | Clean Workspace Explorer rebuild | IMPLEMENTED; FUNCTIONALLY VERIFIED | `9334a66`; explorer tests | No phase-specific external acceptance evidence found. |
| D03.14.1 | Private project workspaces | IMPLEMENTED; FUNCTIONALLY VERIFIED | `868922c`; private-context/application/persistence tests | No phase-specific external acceptance evidence found. |
| D03.14.1a | MCP messaging authoring guidance | IMPLEMENTED; FUNCTIONALLY VERIFIED | `7ee4384`; MCP tools/reference tests | Guidance does not establish external agent acceptance. |
| D03.14.2 | Cross-context architectural analysis | IMPLEMENTED; FUNCTIONALLY VERIFIED | `3342d98`; `tests/features/preview/cross-context-analysis.test.ts` | Keep provenance, candidate, relationship and unknown classes distinct. |
| D03.14.3 | Architectural Proposals | IMPLEMENTED; FUNCTIONALLY VERIFIED | `a913ab2`; proposal application, persistence and API tests | Submission remains distinct from review and promotion. |
| D03.14.4 | Proposal review and impact | IMPLEMENTED; FUNCTIONALLY VERIFIED | `61f258e`; proposal diff/review tests | Approval is not publication. |
| D03.14.4.5 | Authoritative resource lifecycle foundation | IMPLEMENTED; FUNCTIONALLY VERIFIED | `bfe9dda`; lifecycle and persistence tests | Retirement preserves history; no external acceptance evidence found. |
| D03.14.5 | Promotion and authoritative lineage | IMPLEMENTED; FUNCTIONALLY VERIFIED; PARTIALLY VERIFIED | `c44794a`, `916b2432`; `tests/persistence/authoritative-batch.test.ts`, proposal detail test | Exact relationship-ADD idempotency is implemented and regression-tested. Real Data Transactions Consumer proposal promotion remains unverified. |
| D03.14.6 | Governed architectural proposal completion | IMPLEMENTED; FUNCTIONALLY VERIFIED | `c2a38b4`; proposal, promotion, API/MCP and UI tests | User-reported external promotion outcome for the real Data Transactions Consumer proposal is still pending. |

The D03.3 pilot observations above are externally reported results, not
reproducible repository tests. They establish behavior for the exercised cases,
not exhaustive acceptance. In particular, `CURRENT` says that the assessment
matches the current candidate fingerprint and evidence checks; it does not mean
the proposed correspondence is true or independently proven.

Proposal promotion in `916b2432` compares exact relationship fingerprints:
repeating an identical relationship `ADD` is accepted idempotently, while an
existing relationship with different kind or roles conflicts. Repository tests
cover this behavior, including rollback on conflict. They do not establish that
the real Data Transactions Consumer proposal has been promoted successfully.
No proposal or production data was changed for this roadmap reconciliation.

## Near-Term Sequence

**R01 — Roadmap and evidence reconciliation:** this document records the current
state and gaps. Phase-specific source contracts for D03.4–D03.5 and external
acceptance artifacts not present in the repository remain unverified.

**D03.15–D03.19:** continue only according to their existing contracts. No
implementation was started in this task. This roadmap does not assign new phase
numbers or claim that broader semantic analysis already ships.

## Prioritized Backlog

| Priority | Item | State / next step |
| --- | --- | --- |
| P0 | Acceptance of exact relationship promotion idempotency | Run the real Data Transactions Consumer proposal through promotion and retain verifiable outcome evidence. |
| P0 | MCP observability of anchors and bindings | Verify anchor/binding visibility in large responses; improve only where evidence shows truncation or omission. |
| P0 | Verifiable deployed-version identification | Establish a reliable way to identify the running version against the repository revision. |
| P1 | Shared skill for consuming agents | Define and validate common agent guidance across consumers. |
| P1 | Semantic quality audit of enriched models | Assess model quality without converting missing documentation into false negatives. |
| P1 | Visual verification of causal diagrams | Verify rendered causal diagrams at representative sizes and complexity. |

## Future Analysis

- **D04 — Semantic impact analysis:** broader cross-perspective impact reasoning beyond current bounded comparisons and the Proposal Decision Workspace.
- **D05 — Architecture evolution analysis:** broader reasoning over architectural changes and history.

D04 and D05 are future work. Current context analysis, semantic discovery,
proposal review, and resource history do not imply a complete semantic
architecture diff or evolution analysis. See the
[documentation model](./documentation-model.md) for normative representation and
authority rules.

## Unverified Claims

- No individual D03.4 or D03.5 rector contract was found in the inspected current
  documentation/history; their exact intended boundaries and acceptance criteria
  cannot be reconstructed confidently.
- The externally reported BillingMiddleware and Data Transactions Consumer
  outcomes are not independently reproducible from repository fixtures or
  attached external artifacts in this checkout.
- Exhaustive candidate exclusion across every active binding has not been
  externally established.
- Anchor and binding observability for large MCP responses has not been
  established.
- Successful promotion of the real Data Transactions Consumer proposal has not
  been established.
- No verifiable deployed-version evidence was found in the inspected repository
  history.
