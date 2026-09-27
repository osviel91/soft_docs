# Software Docs Manager

Software Docs Manager is a local-first architectural oversight workspace for
software systems. It maintains and exposes architectural knowledge so humans
can understand, navigate, evaluate, and govern system evolution, including
systems developed with AI-assisted and agentic workflows.

Diagrams are projections of that knowledge, not the knowledge model itself. The
product combines editable Sequence views, Event Flow / causal views, and
Markdown resources in projects that can be rendered, searched, validated,
exported, and shared with coding agents.

## The Product

As implementation velocity increases, a human may no longer personally
construct or retain the complete mental model of every change. Passing tests
and compiling code establish executable constraints, but do not necessarily
explain what changed architecturally, which messages or dependencies were
introduced, who produces or consumes them, what consequences or retry behavior
exists, which facts are authoritative, or what remains unknown.

Software Docs Manager provides a human-oriented surface for those questions.
It keeps prose, architectural projections, and semantic connections together
while keeping source readable outside the application.

The product owns the architectural documentation model, diagram languages, and
rendering pipeline. The editor, stdio MCP server, HTTP API, and remote MCP
service use the same domain and application services rather than separate
interpretations.

## Capabilities

Projects currently contain three resource types:

- **Sequence diagrams** use `.seq` source for participants, messages, notes,
  activations, and control-flow fragments.
- **Event flows** use `.eventseq` source for events, producers, consumers,
  brokers, channels, publications, and subscriptions.
- **Documentation** uses `.md` Markdown files with headings, links, wiki-links,
  and diagram embeds.

Resources can be edited in mixed tabs, validated, rendered to deterministic SVG,
searched across a project, renamed without losing stable local identity, and
exported as portable project archives. The project index supplies diagnostics,
outlines, symbols, references, completion, and search facts. Current semantic
capabilities also include explicit message identities, publish/consume/dispatch
occurrences, causal handlers and effects, typed complementary-view
relationships, architectural traces, provenance, and explicit unknown
boundaries where the evidence is incomplete.

Each resource can also carry optional semantic context: a short multiline
description and compact tags. The editor shows this context above the source for
sequence diagrams, event flows, and Markdown, with an inline edit affordance;
clearing both fields removes the block. Server projects save it with the same
optimistic revision checks as source edits, while read-only projects only show
the context. The API and remote MCP expose the same metadata to agents. It is
context for people and agents, not a search taxonomy.

The browser editor provides an explorer, source editor, outline and problems
views, live or explicit rendering, pan/zoom navigation, version history, safe
delete, Markdown preview, and project-wide search.

Project search is metadata-aware: plain text searches names, descriptions, tags,
and content. Use `tag:payments`, `tag:ddd aggregate`, `type:diagram checkout`, or
`type:note deployment` to combine exact tag/type filters with a text query.

## Local And Server Operation

Local-first is the default. A browser can store projects in IndexedDB or open a
folder through the File System Access API. A folder remains a readable project
tree, and the stdio MCP server can work on the same kind of filesystem
workspace.

Server mode adds authenticated shared projects. The API stores project identity,
memberships, resource metadata, revisions, sessions, and audit events in
PostgreSQL; resource content remains in the project storage volume. Workspace
membership scopes which projects are visible and accessible, and project roles
 control permissions within an accessible project. Server writes use optimistic
 revisions so stale edits are rejected instead of silently overwriting changes.

Server knowledge has two explicit contexts: **SHARED** is authoritative project
knowledge, while **MY WORK** is private, tentative knowledge owned by one user
inside that project. MY WORK may read SHARED; SHARED never implicitly reads MY
WORK. The server and MCP enforce this boundary, not Explorer filtering. Existing
server resources without an explicit context remain SHARED.

The browser uses the same editor for local and server projects. The remote MCP
service is a separately deployable, authenticated service over the shared
application layer. It does not call the HTTP API over the network.

## Human And Agent Workflows

Humans can create a project, choose a resource type, edit its source, inspect
diagnostics, and follow links between diagrams and Markdown:

1. Create or open a local project, or sign in to a server workspace.
2. Add sequence, event-flow, and Markdown resources.
3. Use the outline, search, references, and problems views while editing.
4. Render or export the result and keep the source in the project tree.

Agents can use the local stdio MCP server for filesystem work or the authenticated
remote MCP service for server projects. MCP is not merely CRUD for diagrams. It
lets agents discover existing knowledge before changing it, enrich legacy
documentation, create and update artifacts, bind concepts when evidence exists,
trace consequences, and preserve uncertainty when evidence does not exist.
Writes return diagnostics; destructive deletes require confirmation. Agents must
prefer conservative enrichment over speculative completion.

The intended development loop is:

```text
software -> human/agent implementation -> architectural knowledge
         -> semantic/causal analysis -> human evaluation
         -> architectural decision -> implementation/publication
```

Documentation is therefore an interface between people and software-development
agents, not only an output of implementation.

## Analysis Workspace Direction

The emerging Analysis Workspace is intended to inspect two architectural
contexts simultaneously. It is not merely a diagram comparison or text-diff
feature. Its direction includes:

- cross-resource analysis through shared semantic knowledge;
- multi-perspective analysis across execution, causal, topology, and other views;
- discovery of semantic connections that are not yet explicitly related;
- eventual evolution analysis across states or revisions;
- proposed-versus-shared architecture review before publication.

The long-term comparison is **current architectural knowledge versus proposed
architectural knowledge**, not simply old DSL versus new DSL. Useful results may
include shared behavior, added or removed documented behavior, changed
producers or consumers, new consequences or effects, changed failure/retry
semantics, knowledge asymmetry, unresolved candidates, and unknown boundaries.
Absence from one resource is not proof that behavior is absent from the system.

The current product has resource viewing, semantic navigation, and revision
foundations. Private architectural resources and full semantic architecture
comparison are future direction, not currently available capabilities. The
intended future workflow is feature branch or work in progress -> private
architectural knowledge -> Analysis Workspace -> human evaluation -> publish
when appropriate.

## Product Principles

- **Knowledge over diagrams:** diagrams are views over architectural knowledge.
- **Evidence over inference:** plausible architecture is not an authoritative fact.
- **Unknown is meaningful:** preserve uncertainty explicitly.
- **Identity over naming:** equal names do not establish semantic identity.
- **Semantics over textual diff:** architectural change matters more than DSL line changes.
- **Human oversight over autonomous completion:** agents assist understanding; they do not manufacture completeness.
- **Progressive enrichment over forced migration:** legacy documentation should become richer incrementally.
- **Multiple perspectives, one knowledge graph:** execution, causal, topology, documentation, and future views correlate without being conflated.
- **Traceability over hidden coupling:** make consequences navigable across resources and views.

The normative authoring and modeling rules are in
[docs/documentation-model.md](./docs/documentation-model.md). Development and
agent constraints are in [AGENTS.md](./AGENTS.md).

## Architecture At A Glance

Diagram source follows the shared pipeline:

```text
DSL -> lexer/parser -> AST -> validation -> layout -> render model -> SVG
```

The Markdown renderer is a separate source-to-HTML path. The project index,
search, archive, and MCP layers consume project resources beside the rendering
pipeline. React is a host for the editor, not the owner of language semantics.

The main boundaries are:

- `src/language` parses and validates source without React.
- `src/domain` contains framework-free models, indexing, search, and policies.
- `src/layout` computes geometry; `src/renderer` emits SVG without parsing.
- `src/application` contains shared use cases and authorization.
- `src/workspace` provides local repository adapters.
- `src/persistence` provides server repositories and project storage.
- `mcp/`, `apps/api/`, and `apps/mcp/` are stdio, HTTP, and remote-MCP hosts.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for boundaries and decision records,
and [CONTEXT.md](./CONTEXT.md) for the project vocabulary. The normative rules
for choosing documentation representations are in
[docs/documentation-model.md](./docs/documentation-model.md).

## Development

Requirements: Node.js and npm.

```bash
npm ci
npm run dev
```

The development server runs at <http://localhost:5173/>. Useful checks:

```bash
npm run verify       # lint, typecheck, full tests, MCP build/smoke/tests
npm run build        # production web, API, stdio MCP, and remote MCP bundles
npm run format:check
```

For browser smoke tests, install Chromium once and run:

```bash
npx playwright install chromium
npm run test:e2e
```

The broader container check is `npm run test:containers`.

To build and run the local stdio MCP server:

```bash
npm run mcp:build
node dist-mcp/server.mjs --workspace ./docs
```

## Deployment

The static local-first deployment needs only the web image:

```bash
docker compose up --build -d
```

It serves the browser at <http://localhost:8080/> by default. Portainer users
can use [`deploy/portainer-stack.yml`](./deploy/portainer-stack.yml); pin
`IMAGE_TAG` to an immutable image tag for repeatable deployments.

The full server deployment runs the reverse proxy, web app, API, remote MCP,
and PostgreSQL:

```bash
docker compose -f compose.production.yml up --build -d
```

Configure the required secrets, database, public URLs, and OIDC values from
[`.env.example`](./.env.example). Published images can be supplied through
`WEB_IMAGE`, `API_IMAGE`, `MCP_IMAGE`, and `PROXY_IMAGE`.

## Documentation Map

- [Canonical documentation model](./docs/documentation-model.md)
- [Architecture and ADRs](./ARCHITECTURE.md)
- [Current vocabulary](./CONTEXT.md)
- [H01 architecture baseline](./docs/architecture-baseline.md)
- [Historical plans and reports](./docs/history/README.md)
- [Production deployment files](./deploy/)
- [Static Docker composition](./docker-compose.yml)
- [Full server composition](./compose.production.yml)

Build output in `dist/`, `dist-mcp/`, `dist-api/`, and `dist-mcp-service/` is
generated and is not source documentation.
