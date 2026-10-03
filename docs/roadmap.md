# Roadmap

This roadmap separates shipped capability from planned analysis. It is a concise
direction record, not a delivery schedule.

## Current baseline

- D03.14 context analysis, private MY WORK, Architectural Proposals, and the
  Proposal Decision Workspace are implemented. See the
  [documentation model](./documentation-model.md) for current behavior and
  authority rules.
- Proposal comparison uses the immutable SHARED base and submitted snapshot;
  current SHARED is used to assess staleness and promotion readiness.
- Semantic comparisons are limited to explicit evidence and implemented queries.
  They preserve candidates and unknown boundaries rather than inferring
  architecture from names or missing resources.

## Near-term sequence

- **R01 — Architecture and governance baseline:** reconcile normative product,
  architecture, MCP, and deployment documentation with the implemented system.
- **D03.15–D03.19:** continue the D03 analysis-workspace sequence through
  evidence-backed context and proposal analysis. Each increment must preserve
  provenance, authority boundaries, explicit evidence, and unknowns; do not treat
  this range as a claim that broader semantic impact analysis already ships.

## Future analysis

- **D04 — Semantic impact analysis:** broader cross-perspective impact reasoning
  beyond the current bounded comparisons and Proposal Decision Workspace.
- **D05 — Architecture evolution analysis:** broader reasoning over architectural
  change and evolution history.

D04 and D05 are future work. No complete semantic architecture diff or evolution
analysis is implied by current context comparison, semantic discovery, or
proposal review.
