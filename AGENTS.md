# Agent Guide

## Product

- Software Docs Manager maintains and exposes architectural knowledge for human understanding and oversight of system evolution. It is not primarily a diagramming application; diagrams are projections of the knowledge model.
- The product is designed for human, AI-assisted, and agentic development workflows. Passing tests or compiling code does not by itself establish the architectural consequences of a change.
- Its owned core is the two language parsers/validators, framework-free domain and layout models, deterministic SVG renderer, project index, and local workspace repositories. The React UI, stdio MCP server, HTTP API, and remote MCP service all consume those shared layers.

## Architectural Knowledge Rules

- Keep documentation resources, Sequence views, Event Flow / causal views, semantic message identities, publish/consume/dispatch occurrences, typed resource relationships, handlers, effects, failure/retry semantics, architectural traces, provenance, and explicit unknown boundaries semantically distinct.
- Equal message names are candidates, not proof of one semantic identity. A shared semantic identity is not a complementary-view relationship. An effect is not an architectural message.
- Absence from a resource is not proof that behavior does not exist. Unknown is not false, and missing evidence must remain visible rather than being filled with plausible architecture.
- A candidate becomes authoritative only through explicit evidence-backed identity or binding. Preserve progressive enrichment from legacy or unstructured knowledge to structured occurrence, candidate, authoritative binding, and cross-view traceability.
- Documentation can be incomplete without being invalid. Prefer a truthful partial representation over a complete-looking invented one.

## Human Oversight Direction

- Treat MCP as an architectural knowledge surface, not CRUD for diagrams. Agents should discover existing knowledge before editing, enrich legacy artifacts, bind concepts only when evidence exists, trace consequences, and preserve uncertainty otherwise.
- Prefer conservative enrichment over speculative completion. The human/agent loop is implementation -> architectural knowledge -> semantic/causal analysis -> human evaluation -> architectural decision -> implementation or publication.
- Server knowledge contexts are explicit: LOCAL is machine-local, SHARED is authoritative project knowledge, and MY WORK is private tentative knowledge owned by one user inside a shared project. MY WORK may read SHARED; SHARED must not read MY WORK. The server/MCP boundary, not Explorer filtering, enforces privacy.
- PROPOSAL is team-visible submitted knowledge, still non-authoritative. It is an immutable snapshot selected from MY WORK, never a live alias or SHARED. Review evidence is separate from publication; explicit, independently authorized promotion is the only ArchitecturalProposal path that mutates SHARED.
- Current Analysis Workspace capabilities include two-context inspection, cross-resource and multi-perspective discovery, semantic comparison where evidence supports it, and the Proposal Decision Workspace. D04/D05 broader semantic impact and evolution analysis remain future work.
- MY WORK, proposals, D03.14 context analysis, and proposal decisions are implemented. Do not describe future semantic architecture comparison as implemented.
- Agents must validate and analyze before submission where practical, report selected resources and dependency closure, require explicit submission intent, preserve unknowns, and never submit automatically or mutate SHARED during submission.
- SHARED resources use a non-destructive `ACTIVE -> RETIRED` lifecycle. Removing a resource from current authoritative knowledge must preserve its identity, revisions, and historical relationship evidence; do not reintroduce hard-delete semantics for SHARED resources.
- Distinguish current capabilities, work in progress, and future intent in documentation and agent responses. Link product-facing summaries to `docs/documentation-model.md` for normative representation rules.

## Commands

- Install with `npm ci`; `.npmrc` intentionally keeps npm's cache in the ignored `./.npm-cache/` directory.
- Run the focused Vitest file with `npm test -- tests/language/parser.test.ts`; `npm test` runs all jsdom, API, persistence, MCP, and architecture tests.
- Match CI's fast gates with `npm run lint && npm run typecheck && npm test && npm run test:mcp`.
- `npm run test:e2e` builds the web/API/remote-MCP bundles and boots them with PGlite; install Chromium first with `npx playwright install chromium`. Set `E2E_PORT` only when the default preview port conflicts.
- `npm run test:containers` exercises the production Dockerfiles and compose topology; use it for API/MCP/storage integration changes.
- `npm run build` type-checks every host and writes `dist/`, `dist-mcp/`, `dist-api/`, and `dist-mcp-service/`; those directories are build output, never edit them.

## Structure

- The browser entry is `src/main.tsx` -> `src/App.tsx`. Keep diagram semantics in the pipeline: `src/language` -> `src/domain` -> `src/layout` -> `src/renderer`; React features consume its results.
- `src/application` is the shared use-case layer. `mcp/` (stdio), `apps/api/` (HTTP), and `apps/mcp/` (remote MCP) are hosts/adapters over it, not peers.
- The browser's `/api` and `/auth` requests are same-origin and Vite proxies both to `SDM_API_TARGET` (default `http://127.0.0.1:8787`). Run `npm run api` separately when manually testing server-backed browser flows.
- Local-first web and stdio MCP need no environment. API/remote-MCP configuration is validated at startup; copy `.env.example` only for server mode. `DATABASE_URL` and `COOKIE_SECRET` are required; use `PGLITE_DIR=memory://` only in tests/development.

## Deployment

- Static local-first deployment: `docker compose up --build -d` serves the web image on `http://localhost:8080` (override with `WEB_PORT`). It has no backend, database, or server-side state.
- Portainer static deployment uses `deploy/portainer-stack.yml`; set `IMAGE_TAG` (prefer immutable `sha-<short>`) and optionally `WEB_PORT`. Published web images are `ghcr.io/osviel91/softeare_docs`.
- Full server deployment: set the required secrets and public URLs in `.env`, optionally set `PLATFORM_ADMIN_EMAIL`, then run `docker compose -f compose.production.yml up --build -d`. It runs reverse proxy, web, API, remote MCP, and PostgreSQL; API and MCP share the `project-data` volume but never call each other over HTTP.
- The production composition requires `POSTGRES_PASSWORD`, `COOKIE_SECRET`, `TOKEN_PEPPER`, `API_PUBLIC_URL`, `MCP_PUBLIC_URL`, and all OIDC values. For published images, set `WEB_IMAGE`, `API_IMAGE`, `MCP_IMAGE`, and `PROXY_IMAGE` to pinned GHCR tags instead of building on the host.

## Boundaries

- Do not let renderers parse source, editors compute geometry, or language/domain/application modules import React/features.
- Keep `src/domain` independent of `src/application`; keep `src/application` independent of `src/persistence` and all hosts. Hosts must not import each other or `src/features`. These rules are enforced by `tests/architecture/boundaries.test.ts`.
- Add a DSL feature across grammar, AST, validation, layout, and renderer. For project facts, use `ProjectIndex`; panels/completion/hover/references must not independently re-parse resources.
