# Software Docs MCP Governance

This is the normative, agent-independent protocol for using Software Docs Manager through MCP. Apply it whenever inspecting or changing Software Docs architecture knowledge. It governs agent decisions; it does not add capabilities to the MCP server or replace its authorization checks.

For artifact meaning, choose representations and interpret documentation, `docs/documentation-model.md` is authoritative. This protocol does not redefine it. Discover the connected server's live tool/resource catalog and instructions before relying on operation names or availability.

## 1. Identify the MCP surface and target

First establish which MCP server and workspace the client actually connected to:

- **Local stdio MCP** operates on a local filesystem workspace. It does not provide the remote server's SHARED/MY WORK/Architectural Proposal governance unless the live server explicitly says otherwise. Do not call a local file canonical SHARED knowledge.
- **Remote governed MCP** operates on authenticated server projects and may expose SHARED, owned MY WORK, Architectural Proposals, reviews, and promotion. Actual operations depend on the connected server, token scopes, membership, and client-exposed tools.
- Do not infer the surface from a tool name, prompt, local repository, or remembered server version. Check initialize/discovery instructions and available tools/resources. If the client hides those, state the limitation and use only operations it actually exposes.

For remote work:

1. Discover workspaces and select the intended `workspaceId`; when multiple are accessible, never silently choose a default.
2. List projects in that workspace and confirm the exact `projectId` and project identity. Check project role/permissions where available.
3. Before private reads or writes, list the caller's private work contexts and select an owned context by exact `contextId`. A project is not a context.
4. Preserve pagination cursors and exact stable IDs returned by tools. Do not derive IDs from names or titles.

`get_project_capabilities` and similar capability results are advisory observations, not grants. A mutation rechecks credentials, project membership, ownership, target state, and revisions at its operation boundary (TOCTOU).

## 2. Discover tools and resources at runtime

- Prefer the connected server's MCP instructions, tool descriptions/input schemas/annotations, and advertised resources over remembered catalogs. Discover them dynamically where supported (`tools/list`, `resources/list`, resource templates, or equivalent client UI).
- Read the relevant authoring reference before writing an artifact when the server exposes one. In particular, use the artifact-authoring guidance and representation-specific DSL reference. If unavailable, do not invent syntax; report the missing reference and stay read-only or ask for guidance.
- A tool absent from the connected catalog is unavailable for this interaction. Do not invent its name, substitute a similar write, or claim it ran. If the needed resource is unavailable, use another verified read surface or state that the evidence could not be obtained.
- Tool annotations such as `readOnlyHint` help clients classify operations; they do not authorize them. Tool descriptions guide use; application use cases enforce authority.
- Do not assume all MCP clients expose `structuredContent`, resources, annotations, or server instructions to the model. Interpret the returned text when that is all the client supplies. Check explicit error indicators/text. If exact state or identifiers cannot be recovered confidently, re-read through an available surface or state the uncertainty; never fill fields from memory.

## 3. Read architecture and preserve provenance

**SHARED** is authoritative project knowledge. It is not proof that runtime matches the documented architecture.

Read relevant SHARED resources before making architectural claims. Inspect resource identity/revision, content, metadata and typed relationships as available; search by topic and read the source rather than relying on snippets alone. Use bounded index/list tools and paginate as needed.

Keep the following evidence classes distinct in analysis and responses:

1. **Documented:** what an identified SHARED artifact says, with resource/revision when available. SHARED is authoritative project knowledge, not proof that runtime matches it.
2. **Observed implementation:** what inspected code, configuration, schema/migration, tests, runtime, or production evidence directly shows. Name the source and scope; tests show tested behavior, not necessarily deployed behavior.
3. **Inference:** a reasoned conclusion from cited observations. Label it and do not present it as a direct observation.
4. **Unknown / not observed:** evidence is absent, inaccessible, incomplete, or conflicting. Absence from a resource is not proof behavior does not exist. Preserve explicit unknowns.

MY WORK is an owner's private tentative view. It may overlay SHARED in an explicitly requested effective view, but always report provenance per resource and do not describe private claims as approved or team-visible. A submitted PROPOSAL is a selected immutable snapshot visible for review, still non-authoritative. Neither MY WORK nor PROPOSAL is SHARED.

Validation checks integrity of represented artifacts; a clean result does not establish completeness, correctness against deployed code, or production state. Traces show bounded, explicitly represented graph connections and may return candidates/unknown boundaries; they do not authorize name-based inference. Use history/trajectory when needed to explain revisions or lineage, not as a substitute for current-state reads.

## 4. Representation and semantic boundaries

Follow `docs/documentation-model.md` for authoritative representation rules. In particular:

- Sequence describes ordered execution and component collaboration. It may include asynchronous interactions when they belong to the evidenced execution.
- Event Flow describes asynchronous/event-driven topology and causal behavior. HTTP routing, synchronous calls, cron invocation, telemetry, or infrastructure topology alone do not establish an Event Flow. No Event Flow may be the truthful result.
- Topology (`publishes`, `consumes`, producers, consumers) is not causal linkage. Causality requires explicit evidence connecting an event to its handler, handler to caused messages, and handler to non-message effects. Do not infer handler outputs from service-level publication lists.
- Sequence execution order cannot be reconstructed from Event Flow topology. Preserve each projection's purpose; do not mechanically duplicate diagrams.
- Retry, delivery, ordering, idempotency, provenance, initiation, authorization, persistence, and failure guarantees require evidence specific to that claim. A broker/queue does not prove retry policy. Keep unknown policy unknown.
- An effect is not a message. Event and command classification is evidence-based; names, suffixes, arrows, and broker presence do not establish it.
- Equal message names are candidate matches, never proof of identity. Reuse/create a SemanticMessageIdentity only through the supported explicit workflow and bind exact occurrences only with evidence. Never invent identity IDs. A shared message identity does not itself create a complementary-view relationship.
- Create a typed complementary-view relationship only when a Sequence and Event Flow substantially represent the same behavior from complementary execution/causal perspectives.
- Conceptual and Database represent durable structure and persistence only where evidence supports it. Do not convert structural knowledge to Markdown or Event Flow as a workaround for visual limits.

## 5. Architectural Proposal navigation and interpretation

Keep **Change Proposals** and **Architectural Proposals** distinct. A Change Proposal is an isolated candidate for its supported resource merge workflow. An Architectural Proposal is a team-visible immutable selection from MY WORK and participates in review/promotion governance.

For Architectural Proposals:

1. List proposals for the confirmed project. Take `proposalId` exactly from the returned item and pass it to the proposal detail operation. Do not construct it from a title, resource ID, or path.
2. Preserve and interpret the fields as returned; do not silently normalize schema variants. Report separately:
   - `recordedStatus` (persisted status; a server may label this `status`),
   - `effectiveStatus` (derived status),
   - `lifecycle.state` (derived lifecycle),
   - promotion evidence and status,
   - supersession/lineage, and
   - consistency diagnostics.
3. A persisted `open` status may coexist with effective/lifecycle `PROMOTED`. This is not by itself inconsistent. Verify durable promotion evidence; do not infer PROMOTED solely from an artifact's presence in SHARED. Conversely, an approval or a preview is not promotion evidence.
4. Interpret promotion evidence literally. `COMMITTED_COMPLETION_PENDING` means commitment with completion work pending; it is not `COMPLETED`. Re-read the evidence/state rather than repeating a promotion mutation.
5. For `SUPERSEDED`, follow the explicit successor/lineage ID and inspect that proposal. Reviews do not transfer. `WITHDRAWN` and `SUPERSEDED` proposals are not eligible for future review/promotion under the documented lifecycle.
6. Diagnostics are evidence of a consistency concern, not permission to repair state or choose whichever status is convenient. Inspect detail, review evidence, trajectory and relevant SHARED resources; report unresolved conflicts explicitly.
7. If fields are missing in a text-only response or client view, do not infer them. State which verification was unavailable.

An `APPROVE` review is a documentary decision. It does not grant operational authority, publish to SHARED, implement code, or deploy. Promotion is a separate explicit action. Any available preview/capability is advisory and time-sensitive; the actual operation must revalidate current authorization and state.

## 6. Authorization matrix for changes

Technical permission, workflow eligibility, and explicit user authorization are three separate conditions. Require all applicable conditions. A code-change request authorizes code changes only; it does not authorize MCP writes, submission, review, promotion, commit, push, PR, merge, publication, or deployment.

| Operation                                       | Explicit user authorization required                                 | Preconditions and boundary                                                                                                                                                                                                                 |
| ----------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Modify code                                     | Yes, for the requested code scope                                    | Inspect existing architecture and classify structural impact. Report artifact scope, including no artifact change where evidence supports that conclusion. Do not infer permission for MCP/documentation writes.                           |
| Edit MY WORK resources/relationships/identities | Yes, naming private documentation work or a sufficiently clear scope | Confirm owned active context and exact ID; read current source/revision first; write only with context ID and expected revision; validate. This never changes SHARED.                                                                      |
| Submit Architectural Proposal                   | Yes, explicitly to make selected knowledge team-visible              | Validate and analyze/trace where practical. State selected resources and dependency closure. Submit only the selected MY WORK snapshot. Submission is not publication to SHARED.                                                           |
| Review proposal                                 | Yes, explicitly to record `APPROVE` or `REQUEST_CHANGES`             | Inspect proposal, base/current state, diagnostics, evidence and policy; check current authority. Review is not publication.                                                                                                                |
| Revise/withdraw proposal                        | Yes, explicitly to replace or withdraw it                            | Re-read exact proposal and owned MY WORK. Revision creates a new immutable successor; review records do not transfer. Withdrawal preserves history and prevents promotion. Neither mutates SHARED.                                         |
| Promote proposal to SHARED                      | Yes, explicitly for the named proposal/publication                   | Confirm operation exists in live tool catalog, permission, ownership/state, validation, reviews/policy and current preview. Execution revalidates; preview does not grant permission. Re-read SHARED and promotion evidence after success. |
| Operational change / production execution       | Yes, explicitly for the concrete operation and target                | Independently verify environment, effect, scope, permission and available operational tool. A promoted document is not an operational command.                                                                                             |
| Publish / deploy                                | Yes, explicitly and separately                                       | Verify target and independent execution/deployment evidence. Tests, code merge, release notes, proposal approval or promotion do not prove production deployment.                                                                          |

For deletion, irreversible changes, external publication, and operational side effects, confirm exact target and effect before invocation. If explicit authorization, required permissions, a supported tool, or current-state evidence is missing, stop before writing and explain the blocker. Never call a write merely because the tool is available or capabilities say it appears allowed.

Every resource write must use the owned `contextId` and revision actually read when required. On conflict/stale revision, re-read affected state and understand the change before deciding what to do; never retry blindly. Idempotency keys make retries safer only for the same intended operation and do not authorize it.

## 7. Errors and reporting

- Check MCP's explicit error flag and textual error content. A tool failure is not a successful empty result.
- Preserve denial reasons (scope, role, ownership, context, lifecycle, stale revision, conflict) as returned; do not bypass with another write surface.
- On not-found/forbidden ambiguity, do not expose or guess private IDs or existence. Use the server's safe response.
- After a successful write, read the resulting resource/state and validate where applicable. A returned success alone may not prove the intended effect is visible.
- Report separately: analysis, local implementation, tests, proposal/review state, SHARED publication, and production deployment. Do not claim one proves another.

## 8. Authoritative references and portability

- `docs/documentation-model.md` is authoritative for representation and documentation semantics.
- This file is the single normative MCP governance protocol. Agent-specific `SKILL.md`/instruction files are loaders only and must not copy its rules.
- Agent skill discovery is product-specific. Discover installed skill mechanisms at runtime or follow the verified adapter for that client. If this file cannot be located/read, do not guess its content: continue with read-only MCP discovery if safe, and ask for the protocol or report the blocker before any write.
- Tool and resource catalogs are runtime facts, not static promises. Record unavailable tools/references as limitations; do not invent operations or capabilities.
