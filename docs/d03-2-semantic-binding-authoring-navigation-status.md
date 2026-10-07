# D03.2 Semantic Binding Authoring & Navigation

**Status:** D03.2B completion gate PASS
**Baseline:** `b1d55ac` (`origin/master`); this matrix records the D03.2B worktree state

## Delivered

- Workspace displays explicit bindings for a selected Conceptual or Database entity, with resolved/unresolved endpoint state, relation, Evidence, provenance, and navigation. Authoring uses exact typed entities from `ProjectIndex`; names do not imply a relationship or Evidence.
- Create, edit, and remove are available only in MY WORK and use the existing API client and governed service operations. Stale revision errors remain visible to the user.
- Proposal submission explicitly selects binding operations; proposal review renders ADD/UPDATE/REMOVE, both endpoint anchors, relation and Evidence as readable text.
- The browser E2E fixture covers the Project -> projects flow through MY WORK, explicit proposal operation selection, independent review, approval, explicit promotion, SHARED, exact-anchor MCP query, and scoped Share/redaction.
- Public projection includes active SHARED bindings only when both endpoint resources are granted. Internal Evidence outside the grant is unavailable/redacted without loading its source.

## Accepted Deferral

- Presentation textual binding navigation remains deferred. It is not required for the main Workspace flow and no parallel Presentation architecture was introduced.

## Completion assessment

| Area | Status | Evidence |
| --- | --- | --- |
| API binding lifecycle and MY WORK governance | PASS | Existing ProjectCatalog/API/persistence lifecycle and proposal governance tests |
| Workspace create/edit/remove and truthful resolution | PASS | `SemanticBindingsPanel.test.tsx`; exact indexed selection, stale revision, unresolved history and no inference |
| Workspace bidirectional entity navigation | PASS | D03.2B browser E2E navigates Project -> projects -> Project by resource ID and stable entity ID |
| Resource path/display rename continuity | PASS | `semantic-binding-query.test.ts` verifies resolution after path and display rename with stable IDs |
| Proposal operation selection and readable review | PASS | UI test submits only the selected ADD; browser E2E reviewer sees both endpoints, relation and Evidence without JSON |
| Approval versus publication; explicit promotion | PASS | Browser E2E verifies approval leaves SHARED unchanged and promotion publishes the selected binding |
| Direct SHARED binding write rejected | PASS | Browser E2E attempts POST without MY WORK context and receives HTTP 422 |
| Exact-anchor MCP result and similar-name non-inference | PASS | Browser E2E queries Project anchor and checks exactly the authored binding; similar entity is excluded |
| Share endpoint scoping and Evidence redaction | PASS | `public-project-projection.test.ts` and browser E2E with both endpoints, one endpoint, and private Evidence |
| ResourceRelationship complementary-view remains separate | PASS | Existing public projection and metadata relationship tests; no relationship mutation in D03.2B |
| SemanticMessageIdentity remains separate | PASS | Existing semantic identity/occurrence tests; binding uses independent EntityAnchor identity |
| Presentation textual binding navigation | NOT IMPLEMENTED (accepted defer) | Explicitly out of the Workspace completion gate; no cross-diagram edges or overlays |
| Full D03.2B E2E completion gate | PASS | Same E2E run verifies authoring -> proposal ADD -> independent reviewer -> approval without publication -> explicit promotion -> SHARED -> exact-anchor MCP -> authorized Share projection and negative controls |

Presentation remains an accepted, clearly separated deferral. D03.2B's Workspace/governance completion gate passes.

## D03.2B.1 Investigation

- The reviewer was still authenticated (`GET /api/me` 200), authorized for the project (`GET /api/projects/{id}` 200), and had the project workspace in its workspace catalog after reload. The URL already carried the stable project ID. No permission, OIDC, catalog propagation or submission race was observed.
- The old E2E helper tried to reopen by project display name through the switcher even though the browser location was already the project route; it waited on a switcher row that could be absent/detached during URL restoration. The test now opens the stable `?project={id}` route and waits for the active project. The proposal is opened through its proposal route, and the reviewer explicitly reveals the initially collapsed “Show proposal details” surface before using Impact/Review. This is an E2E navigation/visibility expectation issue, not a Workspace/auth defect.
- Continuing the same E2E exposed a product identity mismatch after promotion: browser `ProjectIndex` anchors used project-metadata IDs while the promoted binding stored authoritative server resource IDs. The Workspace now bridges each indexed descriptor to the ID of its exact loaded repository file; anchor identity remains resource ID plus stable entity ID. Resource navigation also accepts that canonical server resource ID. The proposal refresh key remounts the binding panel after review/promotion so it fetches the new SHARED state.

## Verification Record

- Focused binding, proposal UI, query, projection, API and persistence tests: 60 passed.
- Full Vitest: 199 files, 2,270 tests passed. The two OIDC timeouts observed in the earlier D03.2B run did not reproduce; `tests/api/auth.test.ts` passed in the full run. No auth changes were made.
- `npm run test:e2e`: passed, including the complete Semantic Binding governed-flow scenario.
- `npm run typecheck`, `npm run lint`, and `git diff --check`: passed.
