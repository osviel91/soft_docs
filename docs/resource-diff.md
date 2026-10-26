# Resource Diff

`ResourceDiff` is a pure comparison of two complete `ResourceState` values. A
state contains content, resource type, and semantic resource metadata. A
`ResourceRevision` and a proposal candidate can both be projected into this
shape without exposing database rows to the diff engine.

The common envelope contains:

- `metadata`: description and case-insensitive tag changes;
- `content`: a representation-specific semantic diff and parser diagnostics;
- `source`: deterministic bounded line hunks for exact or fallback review;
- `summary`: stable counts by change kind and entity.

Event Flow uses event names as identity. Publications are matched by event and
producer; subscriptions by event and consumer. Channel and broker declaration
changes are reported separately, and relationship channel changes are modified
relationships. Event metadata is an open, case-insensitive key map, so unknown
keys remain diffable. Event renames are intentionally an added event plus a
removed event.

Sequence messages have no stable cross-version node identity. H15 therefore uses
deterministic positional message alignment, which is conservative when messages
are inserted or reordered. Participant ids are stable identities; formatting-only
changes produce no semantic changes.

Markdown uses deterministic line/block changes rather than NLP. All
representations also retain bounded source hunks. If either DSL has an error,
semantic content is marked unavailable while source hunks and diagnostics remain
available.

Proposal diffs always compare `baseRevision` to the candidate. The current
canonical revision and `stale` flag are reported separately. A semantic diff is
not merge, conflict detection, or approval; those concerns are deliberately
outside H15.

## Historical revision comparison

The historical Comparison View accepts only two server snapshots whose
`projectId`, nullable `contextId`, `resourceId`, and requested revision numbers
match exactly. Their representation is also checked against the server `type`.
That tuple establishes same-resource lineage; names, paths, content fingerprints,
and visual similarity do not. Each displayed result retains the two revision
numbers as provenance. A response mismatch or authorization failure clears the
pair instead of leaving previously loaded protected content on screen.

For Conceptual and Database snapshots of the same representation, changes
matched by authored stable entity IDs are labelled confirmed. Database columns
without an authored ID use `table ID + column name`; these are explicitly
name-based candidates and are not interpreted as confirmed renames. No rename is
inferred: absent IDs yield add/remove records. A selected difference exposes its
entity key, match basis, old/new parser values where available, revision pair, and
bounded textual hunks. Truncated source or semantic results remain marked partial.

Different representations do not run a semantic adapter. The representation
change and bounded source diff remain available as textual evidence. Invalid DSL
also preserves source evidence and diagnostics while semantic comparison is
unavailable. Sequence, Event Flow, and Markdown historical snapshots are shown
as source-only fallbacks; Markdown block records elsewhere in `ResourceDiff` are
text-derived and must not be described as architectural facts.

The historical UI owns a comparison-local session keyed by project, context,
resource, and revision pair. It invalidates stale async responses by generation;
per-pane viewport transforms are independent and keyed by the snapshot/revision.
It reuses the existing revision list/snapshot API and Conceptual/Database
renderers, but deliberately does not reuse Dual View's resource-only visual
session controller or introduce historical MCP endpoints. Source-only fallback
is available for every server resource representation with a revision snapshot.
