# Canonical Documentation Model

This document is the normative documentation model for Software Docs Manager.
It defines how humans and coding agents choose documentation boundaries,
representations, names, metadata, and granularity. The repository remains the
source of truth for implementation detail; this model records the semantic
knowledge that is expensive to reconstruct repeatedly.

## Purpose And Philosophy

Documentation should optimize for architectural understanding, business-flow
understanding, asynchronous behavior, important contracts, business rules,
invariants, infrastructure boundaries, operational constraints, and agent
discoverability.

Software Docs Manager is an architectural oversight surface, not primarily a
diagramming application. A diagram is a projection of architectural knowledge.
The model exists so a human can evaluate changes made by people, AI-assisted
developers, and autonomous agents even when implementation velocity exceeds one
person's ability to retain the whole system mental model. Tests and compilation
provide executable evidence, but do not by themselves explain architectural
change, message producers and consumers, causal consequences, failure and retry
behavior, authority, candidates, or unknowns.

It should not narrate source code line by line. A useful claim is grounded in
repository evidence and explains a responsibility, relationship, rule, or
outcome that is not obvious from the visual itself.

### Knowledge integrity principles

- **Knowledge over diagrams:** views expose knowledge; they are not the model.
- **Evidence over inference:** plausible architecture must not become an authoritative fact without evidence.
- **Unknown is meaningful:** retain uncertainty and missing boundaries explicitly.
- **Identity over naming:** equal names do not establish semantic identity.
- **Semantics over textual diff:** architectural change matters more than DSL line changes.
- **Human oversight over autonomous completion:** agents assist understanding and must not manufacture completeness.
- **Progressive enrichment over forced migration:** legacy or unstructured knowledge can become richer incrementally.
- **Multiple perspectives, one knowledge graph:** execution, causal, topology, documentation, and future views may correlate without being conflated.
- **Traceability over hidden coupling:** consequences should be navigable across resources and views.

Architectural documentation may be incomplete without being invalid. The
supported enrichment path is:

```text
legacy/unstructured knowledge
  -> structured occurrence
  -> candidate
  -> authoritative identity/binding
  -> cross-view traceability
```

Do not fill missing architecture merely to make a resource look complete.
Absence from a resource does not prove behavioral absence; unknown is not false.

The canonical dimensions are:

| Representation | Primary question                         | Semantic dimension          | Current status                   |
| -------------- | ---------------------------------------- | --------------------------- | -------------------------------- |
| Sequence       | How does this flow execute?              | Execution / time            | Implemented as `.seq`            |
| Event Flow     | What causes what asynchronously?         | Causality / reaction        | Implemented as `.eventseq`       |
| Conceptual     | What concepts or components relate?      | Structure / relationships   | Future contract; not implemented |
| Database       | What data is persisted and how?          | Data / persistence          | Future contract; not implemented |
| Note           | What rule, decision, or context matters? | Context / rules / decisions | Implemented as Markdown (`.md`)  |

Conceptual and Database are semantic contracts for future representations, not
current product capabilities. Do not claim that the product can create,
render, search, or persist them as dedicated diagram types.

The current product supports Sequence, Event Flow, Markdown, semantic message
identity and binding, causal handlers and effects, typed resource relationships,
resource revisions, and agent-facing discovery and mutation surfaces. The
Analysis Workspace supports simultaneous context inspection, cross-resource and
multi-perspective analysis, semantic discovery, and proposal decision review.
Broader architectural change and evolution intelligence remain future work. Server
projects have explicit **MY WORK** contexts: private,
tentative knowledge owned by one user inside the project. This is distinct from
LOCAL machine knowledge and SHARED authoritative project knowledge. MY WORK may
read SHARED, but SHARED never implicitly reads MY WORK; every private fact keeps
its context provenance. Architectural Proposals are the explicit transition from MY
WORK to team-visible review: a selected-resource snapshot is immutable,
non-authoritative, and never a live alias of the source context. Proposal reads
expose only submitted resources and dependencies. Persisted proposal disposition
is `open`, `withdrawn`, or `superseded`; derived lifecycle also reflects review and
promotion state (`OPEN`, `CHANGES_REQUESTED`, `APPROVED`, `PROMOTING`, `PROMOTED`,
`WITHDRAWN`, `SUPERSEDED`). These are not all values of one persisted status enum:
review and promotion have their own evidence/state.

Authoritative SHARED resources have a non-destructive lifecycle: `ACTIVE -> RETIRED`.
Retirement removes a resource from current listings, indexes, fingerprints, and
analysis, but does not remove its stable identity or immutable revision history.
Relationships removed from current SHARED state are retained as historical
relationship evidence. Removing current authoritative knowledge is not destruction
of its history.

## Knowledge Contexts

```text
LOCAL   = local machine knowledge
SHARED  = authoritative server-side project knowledge
MY WORK = private, tentative server-side knowledge owned by one user
PROPOSAL = team-visible, submitted, non-authoritative architectural snapshot
```

The server and MCP enforce this boundary. Explorer grouping is presentation,
not authorization. Existing resources without an explicit context resolve to
SHARED, and private context metadata is not stored in the shared project
manifest. A private context can consume readable SHARED resources, while a
SHARED query excludes private resources, identities, relationships, indexes,
and traces.

Workspace invitation links are transferable bearer credentials, not email or
account invitations. They grant one authenticated user a preselected workspace
role once, expire after seven days, and are stored as a one-way hash. They never
grant project membership independently, expose project knowledge anonymously, or
act as PAT/MCP credentials. Invitation inspection is a minimal public preview;
acceptance requires an active browser session. The resulting workspace role is
not a project role, and existing project/workspace authorization gates remain in
force. Revocation, acceptance, and membership creation are audited atomically.
The `/invite/<token>` route uses only that preview until an authenticated user
explicitly accepts; it does not load project data first. OIDC returns to the same
route through the existing short-lived signed login-state cookie. Local registration
continues to require the platform's ordinary account approval before sign-in.

SHARED semantic identities are currently authoritative in the project manifest
(`project.json`). Resource source carries stable `messageRef` values; the parser,
ProjectIndex, validation, and traces resolve those references against the manifest.
The manifest is persisted on the project volume and survives restart/rebuild. A
message UUID alone is not enough to reconstruct its name or kind. Retirement does
not remove an identity from the manifest, so another active occurrence remains
bound to the same identity.

Authoritative multi-resource mutations, including Proposal promotion, use a
journaled batch envelope. Resource rows, immutable revisions, relationship
retirement evidence, audit, promotion lineage, and batch member intents commit in
one SQL transaction. Resource files and `project.json` are staged before the claim;
unfinished members remain recoverable until every member and the manifest settle.
Promotion evidence is `COMMITTED_COMPLETION_PENDING` until that recovery boundary
is complete, then becomes `COMPLETED`. Pending completion is not reported as a
successful promotion. Replays use the existing idempotency records and preserve
the same resource and semantic identity ids.

PROPOSAL analysis is effective SHARED plus the submitted snapshot, with provenance
retained. A proposal records a SHARED resource-revision vector as its base. Current
resource history can be reconstructed from resource revisions, but relationship and
manifest history are not yet historical proposal bases; a later SHARED vector is
reported as "base has advanced", not as a merge conflict.

### Architectural proposal review

The governance path is:

```text
MY WORK -> PROPOSAL -> REVIEW EVIDENCE
                         |
                            +-- still not SHARED
                                      |
                                      +-- explicit promotion intent -> SHARED
```

Reviews are append-only records containing `APPROVE` or `REQUEST_CHANGES`, a concise
summary, and the Proposal base/current SHARED revision context observed by the
reviewer. Proposal snapshots, submitted identities, relationships, and SHARED are
never changed by review. Approval means acceptable for the next governance step,
not promotion or authority. The displayed review status uses each reviewer's latest
decision: none, approved, changes requested, or mixed. Unknown boundaries,
candidate-only correlations, incomplete validation, and stale bases are evidence
for human review, not automatic rejection or acceptance. Semantic/causal analysis,
anchors, provenance, effects, recovery, and traces are the primary review surface;
textual diffs are not architectural impact.

Self-review policy is workspace governance, not a universal proposal invariant.
The workspace setting `allow_author_self_review` defaults to `false`; when enabled,
an author may approve their own proposal, subject to ordinary review permission
and proposal-state checks. Workspace administrators configure this policy. Review
records remain associated with the proposal on which they were made and are not
transferred to a revised successor.

Capabilities expose advisory decisions based on credential scopes, project role,
ownership, proposal state, workspace governance, and promotion readiness. They do
not grant authority: every mutation use case rechecks permission and current state,
so a change between capability discovery and mutation (TOCTOU) can result in a
denial. PAT scopes and role are both relevant; neither UI visibility nor capability
metadata replaces server-side authorization.

Promotion is separate from review. A preview reports proposed changes and blockers
without mutation. Execution rechecks `promotion:execute`, the OWNER requirement
(or configured workspace-admin governance), review approval, proposal/base state,
and conflicts. Only this authoritative path changes SHARED. Durable promotion
evidence is `COMMITTED_COMPLETION_PENDING` while SQL state is committed but
filesystem/manifest completion remains; it becomes `COMPLETED` after recovery
settles the batch. The derived proposal lifecycle reports these as `PROMOTING` and
`PROMOTED`, respectively.

Revision does not edit a submitted snapshot. The author edits their active MY WORK
and explicitly revises an open proposal, creating an immutable successor with a
fresh SHARED base and `supersedesProposalId` lineage. The predecessor becomes
`superseded`; its snapshot and reviews remain historical, and reviews do not carry
to the successor. Withdrawal is non-destructive: an open proposal becomes
`withdrawn`, retaining snapshot and reviews. Withdrawn and superseded proposals
cannot be reviewed or promoted.

Each submitted resource snapshot carries explicit `CREATE`, `UPDATE`, or `RETIRE`
intent. Omission is not retirement. A RETIRE snapshot names the authoritative
resource and exact base revision; promotion removes it from current SHARED state
without deleting its identity, last active revision, or historical relationship
evidence.

## Explorer Navigation

The workspace sidebar has two mutually exclusive navigation states:

```text
Workspace
└── PROJECT BROWSER
    └── PROJECT EXPLORER

PROJECT
├── SHARED      authoritative
├── MY WORK     private, tentative
├── PROPOSALS   reviewable, non-authoritative
└── LOCAL       machine-local
```

The Project Browser contains workspace selection, project search, server
project discovery, compact project creation, and the meaningful local-folder
entry. Once a server project is open, the Project Explorer replaces the
complete project list with one project header, resource search, and one
provenance tree. It does not retain a second project browser, a Project
Knowledge region, or Explorer-specific splitters.

SHARED, MY WORK, PROPOSALS, and LOCAL are independent navigation and authority
boundaries. Collapsing one section affects only its descendants. This is
provenance presentation only: visual co-location or organizational hierarchy
does not infer authority, semantic identity, a relationship, ownership, or
folder architecture. SHARED remains the only authoritative context; MY WORK,
PROPOSALS, and LOCAL remain distinct. An approved proposal is still not SHARED.

Proposal reads expose predecessor/successor lineage and durable promotion
evidence. The Explorer can reconstruct `PROMOTING`/`PROMOTED` after reload rather
than relying on transient UI state.

## Representation Selection

Use these questions to choose the first useful view; Sequence and Event Flow are
orthogonal projections, not mutually exclusive classifications:

1. A business or use-case execution: **Sequence**.
2. Asynchronous reactions and causal event chains: **Event Flow**.
3. Structural, domain, or architectural relationships: **Conceptual**.
4. Persistence schema and data relationships: **Database**.
5. A cross-cutting rule, decision, or context: **Note**.

Multiple views are appropriate when they answer different questions. A business
Sequence may include asynchronous messages when they are part of the ordered
collaboration, while an Event Flow can separately preserve the meaningful causal
chain behind those messages. Sequence answers execution, time, and component
collaboration; Event Flow answers asynchronous causality, message provenance,
handler responsibility, caused messages, and effects. For example, the UpOne
fan-out from `UpOneTransactionRaisedEvent` through multiple handlers, commands,
and persistence effects can remain a useful ordered Sequence and also be
documented as an Event Flow when that evidence forms a meaningful causal
context. Do not mechanically duplicate every Sequence as an Event Flow; add the
second view only when real asynchronous causal structure is present.

When two resources document substantially the same behavior from these different
angles, record a semantic `complementary-view` relationship. This is stronger
than a Markdown hyperlink: it is stored by stable resource id and exposes the
other resource as a navigable execution or causal view. Do not create the
relationship for merely adjacent topics, shared components, or every pair of a
Sequence and Event Flow.

### Resource Relationships And Semantic Messages

These are three separate concepts:

- A `complementary-view` resource relationship means a Sequence and Event Flow
  are two projections of substantially the same behavior.
- A project-scoped semantic message identity is the stable architectural concept,
  such as `MslTransactionCreatedEvent`. Its display name is not its identity.
- A message occurrence or Event Flow entity may explicitly bind to that identity.
  Equal names are candidates only and never create a binding.

`publish`, `consume`, and `dispatch` belong to Sequence occurrences. `event` or
`command` belongs to the semantic identity and must be compatible with every
explicit binding. Distinct behaviors may intersect through a semantic message
without becoming complementary views. MSL is an example: an ingestion Sequence
and a negative-balance causal flow can share an explicit message identity without
claiming to be the same behavior. UpOne is different: its existing
`complementary-view` relationship remains, and message bindings enrich it.

Semantic identities are project-manifest mutations. The manifest has its own
optimistic revision and is replaced atomically; server mutations require project
update permission and emit the normal project audit event. Bindings remain source
mutations: Sequence and Event Flow edits use ordinary resource revisions and
change-proposal paths. Change Proposals currently model resource content and
metadata, not standalone project-manifest edits, so identity registry changes are
direct governed project mutations rather than silently pretending to be proposal
changes.

The UI exposes bound messages only when the selected rendered node has an explicit
`messageRef`. Its compact inspector shows the kind, occurrence operation, other
authoritative occurrences, and Event Flow representations; candidate name matches
are deliberately omitted. Selecting a listed resource follows the existing
workspace navigation path, so refresh/revalidation can surface the same persisted
bindings without a browser reload.

`SemanticMessageIdentity` is the navigation bridge between ordered execution
documentation and causal Event Flow documentation, not merely storage metadata.
The inspector preserves each target's resource id and local node or step so
navigation focuses the exact occurrence. This differs from a resource
relationship: the relationship connects complementary documents, while the
semantic identity connects representations or occurrences of the same
architectural message.

Similarly, `Merge Change Proposal.seq` can show execution, a proposal
collaboration Event Flow can show asynchronous reactions, a future conceptual
view can show proposal relationships, and a future Database view can show
persistence. These views complement one another; they are not duplicate
accounts of the same fact.

### Assessment guidance

An **INCOMPLETE** representation uses the correct representation and semantic
boundary, but important knowledge is missing. A **MISREPRESENTED** resource uses
a representation whose semantics do not match the observed system behavior.
For example, synchronous HTTP routing represented as an asynchronous Event Flow
is MISREPRESENTED, not merely incomplete.

## Analysis Workspace: Current And Future

The Analysis Workspace / Explorer is the current inspection surface for project
knowledge and proposals. It supports cross-resource navigation, provenance-aware
inspection of SHARED, MY WORK, and LOCAL contexts, semantic comparison where
implemented, and a Proposal Decision Workspace with canonical proposal diff and
change inspection.

D03.13.3 and D03.14.2 provide a read-only Analysis Workspace over two independent
viewer sessions. An Analysis Session supplies context A, context B, an explicit
semantic anchor, bounded trace options, semantic correlation, and separately
indexed typed resource relationships. Each context carries explicit provenance
(SHARED, MY WORK, or LOCAL), so effective private knowledge can combine readable
SHARED facts with private facts without flattening their authority. Its evidence classes remain distinct:
authoritative identity bindings, explicit complementary-view relationships,
architectural trace intersections, candidates, knowledge asymmetry, and
unknown boundaries. A typed relationship is not implied by shared identities.

Analysis uses the existing bounded architectural trace query, including its
direction, depth and node limits, recovery nodes, and cycle references. It
reports "documented only in A/B" rather than added or removed knowledge, and
missing structured recovery as unknown rather than no retry. Candidate names
remain non-authoritative and cannot create identities, bindings, relationships,
or documentation. Cross-context asymmetry means documented only in one context,
not added or removed history. Comparison of resources is not architectural change
history. Analysis results navigate to their indexed source evidence;
the diagrams remain independently zoomed, panned, inspected, and rendered.

The Proposal Decision Workspace separates Explorer/navigation, decision context,
and Change Inspector. Its canonical comparison operands are the immutable SHARED
base captured by the proposal and the immutable submitted snapshot. Current SHARED
is consulted for staleness/readiness, not as a replacement for historical proposal
evidence. This feature does not claim D04's richer cross-perspective impact
reasoning or D05's architecture-evolution analysis. A missing resource-side
representation must never be treated as proof that behavior is absent.

## Sequence Diagrams

Visual representations provide opt-in contextual guidance from the diagram
controls. Guidance opens on demand and does not permanently consume diagram
workspace; its notation follows the active representation.

### Contract

A Sequence Diagram documents one recognizable business or application flow.
It answers: **How does the system execute this business/use-case flow?**

Good boundaries include `Create Workspace`, `Approve Local Account`, `Merge
Change Proposal`, `Place Order`, and `Cancel Subscription`. A controller,
HTTP route, repository method, or database access is not a flow boundary.

The flow normally starts with a meaningful actor or system intention and ends
at the business or application outcome. Do not split a diagram merely because
the implementation crosses files, classes, layers, or services. Split when the
actor intent and business outcome are independently meaningful.

### Participants

Participants represent meaningful collaborators or responsibility boundaries:
an Actor, UI, API, Application Service, Domain Service, Repository, Database,
or External System. Avoid incidental classes and helper functions unless they
are architecturally significant. A reader should understand responsibility
boundaries without knowing the source tree.

### Granularity heuristic

Before creating a Sequence Diagram, ask:

1. Is there a recognizable actor or system intention?
2. Is there a meaningful business or application outcome?
3. Does understanding the collaboration cross multiple responsibilities or
   boundaries?
4. Would the diagram reduce the need to reconstruct the flow from source?

If the answers are generally yes, the flow is a valid candidate. Keep internal
steps in the same diagram when they exist primarily to serve one use case.
Prefer `Merge Change Proposal` over separate diagrams for loading the proposal,
analyzing it, saving a revision, and changing proposal status.

### Annotations

Annotations add semantics that the visual already does not provide. Prioritize:

- business rules and invariants;
- validation and authorization constraints;
- important request, response, query, or result contracts;
- transaction boundaries and concurrency behavior;
- idempotency requirements;
- external-system contracts;
- relevant failure behavior;
- non-obvious infrastructure behavior.

For example, an interaction with `PostgreSQL` may be annotated with “Returns
workspace, membership, and permissions” and “Invariant: workspace belongs to
the requesting tenant.” Avoid notes such as “Calls the repository” when the
message already says that.

### Architectural Message Occurrences

A Sequence interaction remains an ordinary call unless source evidence establishes
that it is an architectural message. When evidence does establish that fact, add
structured metadata immediately after the interaction:

```text
Transaction -->> Handler: MslTransactionCreatedEvent
semantic event publish MslTransactionCreatedEvent
```

The supported kinds are `event` and `command`; the supported operations are
`publish`, `consume`, and `dispatch`. The local message name is display/discovery
data, not identity. Do not infer semantics from suffixes, participant names,
queue presence, or equal names in another resource.

An occurrence that publishes `MslTransactionCreatedEvent` and a later occurrence
that consumes it are separate local occurrences. They are not automatically a
D03.7 complementary-view relationship. MSL Transaction Ingestion may produce
that event while Negative Ledger Balance Notification is an Event Flow entered
by the event and continuing to downstream consequences. That is message-mediated
traceability, not two projections of one complete behavior.

D03.11.2 can add stable semantic message identity through the reserved occurrence
reference, then bind Sequence occurrences and Event Flow entities. D03.11.1
deliberately provides no implicit links or name-based identity.

## Event Flows

### Contract

An Event Flow is a connected view of asynchronous or event-driven behavior
within a meaningful event context. It answers:

- What causes what in the asynchronous system?
- How does the system react when an event occurs?

HTTP requests, synchronous calls, reverse-proxy routing, cron invocation,
logs/telemetry, and infrastructure topology do not establish an Event Flow by
themselves. A project may legitimately contain no Event Flow documentation.
Keep synchronous or structural behavior in its appropriate representation; do
not force it into Event Flow.

It is not merely `producer -> topic -> consumer`. The important model is:

`Event -> Handler -> Effects -> Resulting Events` is an investigation heuristic
when real asynchronous behavior exists, not a mandatory shape for every Event
Flow or every event-like trigger. No asynchronous event context observed is a
valid result, and is preferable to inventing Event Flow coverage.

Effects may include database mutations, external API calls, command dispatch,
notifications, state transitions, and resource creation or deletion.

### Event provenance

Distinguish provenance whenever repository evidence supports it:

- **External event**: enters the documented system boundary, such as a payment
  provider event, GitHub webhook, or message from another bounded context.
- **Internal event**: is produced by the documented application or system,
  such as `OrderPaid`, `ProposalMerged`, or `WorkspaceDeleted`.

Do not guess provenance when the system boundary is ambiguous. Record it as
unknown or omit the claim.

### Handlers and causal semantics

Handlers or consumers are separate semantic concepts in the causal model. When
real asynchronous behavior exists, a reader should be able to discover who
consumes an important event, which handler is responsible, what effects occur,
and what events can result. A broker or channel is infrastructure context, not
a substitute for handler responsibility. The model preserves incomplete
knowledge and does not infer a handler from a consuming service.

The domain representation is an optional causal aggregate alongside the legacy
topology relations: `Event -> Handler -> Effects / Resulting Events`. Handler
inputs and outputs are explicit, so fan-out branches do not create cross-product
edges. Effects have an identity, optional kind, description, and open metadata;
they are not coupled to a database, HTTP client, mail system, or other
technology. Commands and events remain one message-level concept, with an
optional explicit `kind: event|command` metadata value preserved by Causal.

Legacy projections still show services consuming and publishing events, while
the domain model now also carries explicit named handlers, effects, and
handler-specific resulting-event edges. No existing projection infers those
causal facts or changes its legacy appearance.

The canonical authoring form is line-oriented and reference-based:

```text
event TransactionReceived {
  provenance: external
}
event TransactionCreated
handler TransactionHandler in TransactionsService
TransactionReceived handled by TransactionHandler
effect persist-transaction on TransactionHandler kind state-update: Persist transaction
TransactionHandler causes TransactionCreated
```

The `effect` line has no resulting message requirement, so terminal handlers and
partially documented branches remain valid.

Semantic-diff handoff: causal declarations already have stable identities in the
domain model (`handler.id`, `effect.id`, and handler/message pairs) and source
ranges for evidence. A later diff can therefore report handler, input, output,
effect, and provenance additions/removals/changes without changing persistence;
the causal semantic-diff UI and its proposal-specific presentation remain future
work.

### Causal investigation view

The Event Flow **Causal** view is a presentation of explicit causal facts, not
another semantic model. Flow shows event movement, Catalog shows event facts,
and Topology shows service connectivity; Causal shows message-to-handler,
handler-to-message, and handler-to-effect relationships.

Selecting an event, handler, or effect keeps the full graph in place while
emphasizing its immediate causal neighborhood. Upstream means explicit paths
that may produce or precede the selection; downstream means explicit paths that
may follow it. Effects remain owned by their handler and are not rendered as
events in the causal chain. External, internal, and unknown provenance are
shown as message context, not as a causal claim. An optional causal initiation
line (`scheduled`, `external`, `manual`, `startup`, or `unknown` `initiates
<message>`) explains why a root message exists; initiation is independent from
provenance. A scheduler can initiate an internal command. Do not infer
initiation from publication topology.

Legacy topology-only flows intentionally have an empty Causal view. The view
explains that topology is documented but explicit Handler-based causality is
not; it does not infer relationships from `publishes` and `consumes`.

### Event annotations

### Failure and retry semantics

Failure, retry policy, retry mechanism, and causal recovery are separate facts.
`failure` identifies an operation and its evidence-backed classification; `retry`
identifies how recovery is initiated. `same-delivery` describes infrastructure
redelivery, `same-execution` describes handler/runtime processing retry, and
`initiates` points to a distinct application or scheduled message. A scheduled
reconciliation loop is not a broker retry merely because it finds failed work.

Policy fields such as attempt count, delay, backoff, timeout, and exhaustion are
optional. Missing fields remain unknown. The model never infers DLQs, ordering,
idempotency, delivery guarantees, ownership, or concurrency from a queue or from
asynchronous messaging. Business failure may be documented without a retry, and
terminal handling is documented only when evidence establishes it.

Failure/recovery edges remain distinct from ordinary `causes` edges. This lets
the Causal view show a handler failure and its recovery without hiding the real
message and handler path used by explicit application retries.

Add annotations or metadata when they materially affect understanding. Useful
information includes:

- description and trigger/provenance;
- preconditions and business rules;
- reads and writes;
- produced or failure events;
- retry and idempotency behavior;
- ordering and delivery semantics;
- transaction boundary;
- correlation and causation identifiers;
- relevant schema or version.

These are recommendations, not a mandatory checklist. Never invent retry,
transaction, delivery, or idempotency behavior.

### Granularity and context boundaries

Unlike Sequence Diagrams, Event Flows are not one business flow per file. The
primary boundary is a bounded event context: a domain capability, connected
causal network, shared state transition, or strong producer/consumer cluster.
Examples include `Order Lifecycle Events`, `Payment Processing Events`,
`Resource Mutation Events`, and `Proposal Collaboration Events`.

Keep directly causal or strongly related events together even when the graph is
visually large. Split when the graph becomes semantically unrelated, not merely
because it has many nodes. Avoid one file per handler or event when those files
would hide one connected investigation context.

An Event Flow should support investigation. A reader should be able to ask:

- Where can this event originate, and is it external or internal?
- Who consumes it and which handler is responsible?
- What state does it affect and what events can it produce?
- What consumes those events and where does the chain terminate?
- Are there cycles, suspicious missing consumers, unexpected fan-outs, or
  hidden side effects?

## Current Event Flow Capability Gap Analysis

The current `.eventseq` model supports the legacy topology relation model plus
an optional explicit causal aggregate. It has `event`, `broker`,
`topic`/`queue`/`stream`, `producer`/`consumer`/`service`, publication,
subscription, event metadata, named handlers, handler inputs and outputs, and
handler-owned effects. Publications and subscriptions remain topology edges;
causal ordering and cycles are derived in the Flow projection, while the Causal
projection and investigation view use only explicit handler facts.

| Canonical need                                                           | Current status                           | Assessment                                                                                                                |
| ------------------------------------------------------------------------ | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Events, producers, consumers, channels, brokers                          | Supported                                | Native AST, validation, index, outline, projections, and renderer                                                         |
| Event descriptions and schema/domain/version metadata                    | Supported                                | Open `key: value` metadata on event declarations; conventional keys include `domain`, `version`, and `schema`             |
| Publication/subscription relationships and fan-out                       | Supported                                | Native edges; validation reports unknown names and missing producers/consumers                                            |
| Derived causal ordering and cycle indication                             | Supported                                | Flow projection derives order and marks residual cycles                                                                   |
| Source traceability                                                      | Supported                                | Source ranges and stable node IDs cover declarations and edges; metadata entries belong to their event node               |
| Broker/channel topology                                                  | Supported                                | Channel kind and optional broker are represented and projected                                                            |
| Provenance: external versus internal                                     | Supported                                | Optional normalized event field; unknown is explicit and no naming inference is performed                                 |
| Handler identity and handler location                                    | Supported                                | Causal handlers have stable identity and optional hosting service; topology subscriptions remain independent              |
| Handler preconditions, reads, writes, and business effects               | Partially supported                      | Effects are first-class with open metadata; later phases may add richer structured semantics                              |
| Produced events as explicit handler results                              | Supported                                | Explicit handler-output edges preserve independent fan-out branches                                                       |
| Failure events, retries, idempotency, ordering, delivery semantics       | Expressible through annotations/metadata | No validation or structured semantics; unsupported claims must remain unknown                                             |
| Correlation and causation identifiers                                    | Expressible through annotations/metadata | No dedicated event or edge fields                                                                                         |
| Explicit event-to-handler-to-effect graph                                | Supported                                | Explicit `handler`, `handled by`, `causes`, and `effect` lines populate the causal aggregate |
| Trace exploration, fan-out investigation, missing-consumer investigation | Partially supported                      | The Causal investigation view exposes explicit paths and fan-out; topology-only flows remain intentionally non-causal |

This gap analysis is descriptive, not an implementation plan. D01 does not
change the DSL, AST, persistence, MCP surface, or renderer. Later evolution
must preserve current source traceability and avoid turning every annotation
into a required structured field prematurely.

## Notes

A Note is semantic supporting documentation for knowledge that does not need a
dedicated execution, causal, structural, or persistence representation. Good
subjects include authorization models, resource mutation invariants, deployment
constraints, idempotency strategy, transaction guarantees, external API
assumptions, business rules, and operational recovery behavior.

Use a diagram annotation when the information belongs directly to an element or
interaction in that diagram. Use a standalone Markdown Note when it spans
multiple flows, describes a cross-cutting policy or decision, would overload a
diagram, or deserves independent search and discovery. Do not duplicate one
authoritative explanation across diagrams; link or reference the Note when the
product supports that relationship.

## Metadata And Naming

Metadata is semantic context for humans and agents, not prose repeated in every
search result.

- **Title**: use a human-readable semantic name, such as `Merge Change
Proposal`, not `merge-change-proposal.seq`.
- **Description**: explain what the resource documents and why it matters.
  Improve discovery and do not merely repeat the title.
- **Tags**: use stable classification terms such as `proposals`,
  `collaboration`, `persistence`, `authorization`, `events`, and `deployment`.
  Reuse established project vocabulary instead of creating near-duplicates.

Resource paths should derive from semantic intent: `merge-change-proposal.seq`,
`workspace-authorization.md`, and `proposal-collaboration.eventflow` are good
examples. Avoid paths tied unnecessarily to implementation artifacts such as
`ChangeProposalController.seq`, `POST-api-proposals.seq`, or `handler2.eventflow`.
Current paths use `.seq` for Sequence, `.eventseq` for Event Flow, and `.md` for
Notes/documentation; this model does not introduce new extensions for future
Conceptual or Database views.

## Duplication And Evidence

Before creating a resource, inspect existing documentation. Search by title,
description, and tags, then read relevant diagrams and Notes. Prefer updating
the canonical resource or creating a Change Proposal against it. If two
resources substantially overlap, report the overlap instead of silently adding
a second version.

Every important claim should be classified mentally as:

- **Observed**: directly supported by source, tests, configuration, or an
  existing documented contract.
- **Inferred**: a reasoned conclusion from evidence, explicitly marked when it
  matters to a reader.
- **Unknown**: not established by available evidence; omit it or say it is
  unknown rather than guessing.

This rule is especially important for retry behavior, transaction boundaries,
event delivery guarantees, idempotency, authorization, and external/internal
event provenance.

Important claims should retain source references when the current
representation supports them. Current AST nodes carry source ranges and derive
stable node IDs for Sequence and Event Flow declarations and interactions.
Future representations should preserve equivalent traceability; D01 does not
add source-link infrastructure.

## Future Conceptual Diagram Contract

Conceptual Diagrams represent **structure and relationships**. They answer:
**What are the important concepts or components and how are they related?**

Domain examples include `Workspace contains Project` and `Membership grants
Role`. Architecture examples include `Browser -> Nginx -> Application Server`
with PostgreSQL, project volume, and OIDC provider relationships.

They must not represent temporal execution. Use Sequence when order and time
are central; use Event Flow when asynchronous causality and reaction are
central. A Conceptual Diagram should address one coherent structural question,
such as the workspace authorization model, documentation resource model,
deployment architecture, or proposal lifecycle relationships. Avoid an
unreadable “entire application architecture” catch-all graph.

## Future Database Diagram Contract

Database Diagrams represent **data and persistence**. They expose only
architecturally relevant tables or entities, fields, primary keys, foreign
keys, cardinality, uniqueness, important indexes, constraints, and
business-relevant persistence invariants. They should not replicate every
database implementation detail by default.

For example, a proposal persistence view may show `change_proposals` with its
revision, status, actor, and merge fields related to `resources`, annotated with
optimistic concurrency and immutable terminal transitions. This is a future
representation, not a current `.seq`, `.eventseq`, or `.md` capability.

## Coverage Model

Project coverage is a conceptual review model, not a score, dashboard,
persistence feature, or API. Assess whether the project has useful coverage of:

- **Business Flows**: recognizable application/use-case executions.
- **Event Contexts**: bounded asynchronous causal networks.
- **Concepts**: important domain or architecture relationships.
- **Persistence**: important data and storage relationships.
- **Cross-cutting Notes**: policies, constraints, decisions, and operational
  context.

An assessment can say, for example, that `Create Workspace` and `Approve
Account` are covered while `Delete Workspace` is missing, or that `Resource
Mutation Events` exists while `Proposal Collaboration Events` is missing.

## Canonical Agent Workflow

An agent documenting a repository should follow this order:

1. Inspect existing project documentation and metadata.
2. Inspect the repository architecture and relevant source.
3. Discover meaningful business/application flows.
4. Discover asynchronous and event behavior.
5. Discover important structural concepts.
6. Discover persistence boundaries and invariants.
7. Discover cross-cutting rules, constraints, and decisions.
8. Compare discovered knowledge with existing documentation.
9. Identify missing, stale, or overlapping resources.
10. Propose updates through Change Proposals where appropriate.

Discovery precedes authoring. An agent should not create a diagram merely
because it found the first interesting code path. The goal is semantic
consistency: agents inspecting approximately the same evidence should tend
toward comparable representation choices, boundaries, names, metadata,
annotations, and coverage assessments, without requiring byte-for-byte output.

## Dogfooding Plan

After MCP documentation guidance exists, use a coding agent to inspect this
repository with this model and produce a proposed plan covering Business
Flows, Event Contexts, Concepts, Persistence, and Notes. Compare it with the
existing project documentation. Apply any updates through Change Proposals,
not direct canonical mutation. This exercise is a future validation of
reproducibility and is not part of D01 execution.
