/**
 * The MCP tool catalog (Phase 6 §12–22, §54, §57–61).
 *
 * Every tool is a thin adapter. It validates its arguments, resolves a resource,
 * and calls a use case on the shared {@link ProjectCatalog} — the *same* catalog
 * the HTTP API calls, whose resource mutations go through the one journaled
 * mutation service. No tool touches PostgreSQL, opens a file, or decides whether
 * the caller may act: authorization is `requirePermission` inside the use case.
 *
 * ## Three levels, and why the levels matter
 *
 * - **Discovery** (`list_projects`, `get_project`, `get_project_index`,
 *   `list_resources`, `get_resource_metadata`, `search_project`) is cheap and
 *   bounded. An agent calls these to decide what to do next.
 * - **Primitive resources** (`read_resource`, `create_resource`,
 *   `update_resource`, `move_resource`, `delete_resource`) map almost directly
 *   onto application use cases and are what an agent should fall back to.
 * - **Semantic tools** (`read_diagram`, `upsert_sequence_diagram`,
 *   `render_diagram`, `read_documentation`, `upsert_documentation`,
 *   `get_event_catalog`, `find_event_producers`, `find_event_consumers`,
 *   `validate_project`) are what an agent should *prefer*: they parse, validate,
 *   preserve identity and apply the revision in one idempotent operation.
 *
 * ## No tool explosion
 *
 * There is one `search_project`, not one per resource kind. There is one
 * `get_resource_metadata`, not `get_diagram` plus `get_note`. A tool earns its
 * place by having a distinct intent, a typed schema, a bounded result and a
 * predictable permission.
 *
 * ## What an agent can never send
 *
 * No schema has `absolutePath`, `hostPath`, `rootDirectory` or `shellCommand`.
 * A path is always a project-relative resource path, validated by the storage
 * boundary. `additionalProperties` is denied by the server's strict-argument
 * check, so an unknown field is a refusal rather than a silently ignored key.
 */
import { z } from "zod";
import type { ApplicationContext } from "../../../src/application/context";
import type { Permission } from "../../../src/domain/access/permissions";
import type { ProjectCatalog } from "../../../src/application/project-catalog";
import type { ChangeProposalService } from "../../../src/application/change-proposal-service";
import type { ArchitecturalProposalService } from "../../../src/application/architectural-proposal-service";
import type { PromotionService } from "../../../src/application/promotion-service";
import type { CapabilityService } from "../../../src/application/capability-service";
import type { ResourceTrajectoryService } from "../../../src/application/resource-trajectory-service";
import type { ResourceRecord } from "../../../src/application/ports/project-repository";
import { invalid, notFound } from "../../../src/application/errors";
import { analyze } from "../../../src/language/analyze";
import { diagramTitle } from "../../../src/language/diagram-title";
import { analyzeEventFlow } from "../../../src/language/eventflow/parser";
import { effectsFor, handlersFor, resultingEventsFor } from "../../../src/domain/eventflow/causality";
import {
  eventsOf,
  publicationsOf,
  subscriptionsOf,
} from "../../../src/domain/eventflow/ast";
import { walkStatements } from "../../../src/domain/diagram/ast";
import { diagramToSvg } from "../../../src/renderer/pipeline/diagram-to-svg";
import { eventFlowSourceToSvg } from "../../../src/renderer/pipeline/eventflow-to-svg";
import { buildProjectIndex } from "../../../src/domain/project/project-index";
import { analyzeResource } from "../../../src/domain/project/resource-analysis";
import { validateProject } from "../../../src/domain/project/validate";
import { semanticMessagesOf } from "../../../src/domain/diagram/semantic-messages";
import { semanticMessageCandidates, traceSemanticMessage } from "../../../src/domain/project/semantic-message-trace";
import { traceArchitectureQuery } from "../../../src/domain/project/architecture-trace";
import {
  createEmptyMetadata,
  type ProjectMetadata,
} from "../../../src/domain/workspace/metadata";
import {
  parseSearchQuery,
  searchProject,
  type SearchDocument,
} from "../../../src/domain/search/project-search";
import type { ToolAnnotations } from "../../../src/shared/mcp/protocol";
import type { McpConfig } from "../config";
import { normalizeResourceMetadata } from "../../../src/domain/workspace/resource-metadata";
import type { ResourceRelationship } from "../../../src/domain/workspace/resource-relationship";

/** A tool's result before the dispatcher wraps it in an MCP result. */
export interface ToolOutcome {
  text: string;
  structured?: Record<string, unknown>;
}

/** What a tool handler runs against. */
export interface ToolContext {
  context: ApplicationContext;
  catalog: ProjectCatalog;
  proposals: ChangeProposalService;
  architecturalProposals: ArchitecturalProposalService;
  promotion: PromotionService;
  capabilities: CapabilityService;
  trajectory: ResourceTrajectoryService;
  config: McpConfig;
  /** Aborted when the client disconnects or the tool deadline elapses. */
  signal?: AbortSignal;
}

/** One entry in the MCP catalog. */
export interface McpTool {
  name: string;
  title: string;
  description: string;
  /** The Zod raw shape the SDK turns into JSON Schema and validates against. */
  inputSchema: Record<string, z.ZodType>;
  annotations: ToolAnnotations;
  /**
   * Every permission the *credential* must carry to call this tool.
   *
   * All are required: an upsert needs both create and update, so a token that
   * could only create cannot use it to overwrite.
   */
  requiredPermissions: readonly Permission[];
  run(
    args: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolOutcome>;
}

// ---- Shared schema building blocks -----------------------------------------

/** A project id. */
const projectId = () =>
  z.string().uuid().describe("The project id from list_projects.");

/** A resource reference: an id or a project-relative path. */
const resourceReference = () =>
  z
    .string()
    .min(1)
    .describe(
      'The resource id or its project-relative path (for example "checkout.seq").',
    );

/** A page size. */
const limit = (fallback: number, max: number) =>
  z
    .number()
    .int()
    .min(1)
    .max(max)
    .optional()
    .describe(
      `How many results to return (default ${fallback}, maximum ${max}).`,
    );

/** An opaque pagination cursor from a previous call's `nextCursor`. */
const cursor = () =>
  z
    .string()
    .min(1)
    .optional()
    .describe(
      "The `nextCursor` from the previous page, or omitted for the first.",
    );

const entityAnchorSchema = z.object({
  version: z.literal(1),
  resourceId: z.string().min(1).describe("Stable resource id from the bindable-entity listing."),
  representation: z.enum(["conceptual", "database"]),
  entityKind: z.enum(["concept", "conceptual-relationship", "table", "foreign-key", "primary-key", "unique-key", "index", "column"]),
  identity: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("local-id"), value: z.string().min(1) }).strict(),
    z.object({ kind: z.literal("table-column-name"), tableId: z.string().min(1), name: z.string().min(1) }).strict(),
  ]),
}).strict().describe("Copy the exact anchor returned for a bindable entity; do not reconstruct it from its display name.");

const bindingEvidenceSchema = z.object({
  version: z.literal(1),
  rationale: z.string().trim().min(1).describe("Why repository or migration evidence establishes this relation."),
  items: z.array(z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("internal"), resourceId: z.string().min(1), revision: z.number().int().min(1), entity: entityAnchorSchema.optional(), range: z.object({ start: z.object({ line: z.number().int().min(0), column: z.number().int().min(0) }).strict(), end: z.object({ line: z.number().int().min(0), column: z.number().int().min(0) }).strict() }).strict().optional() }).strict(),
    z.object({ kind: z.literal("external"), reference: z.string().trim().min(1), description: z.string().trim().min(1) }).strict(),
  ])).min(1),
}).strict();

const semanticBindingInputSchema = z.object({
  id: z.string().uuid().describe("Client-generated binding UUID; not an entity or message identity."),
  left: entityAnchorSchema,
  right: entityAnchorSchema,
  relation: z.enum(["represents-in"]),
  evidence: bindingEvidenceSchema,
}).strict();

const semanticBindingUpdateSchema = semanticBindingInputSchema.extend({
  revision: z.number().int().min(1),
  status: z.enum(["ACTIVE", "RETIRED"]),
  provenance: z.object({ authorId: z.string().min(1), contextId: z.string().uuid().optional(), proposalId: z.string().uuid().optional(), createdAt: z.string().datetime() }).strict(),
}).strict();

/** A retry key that makes a mutation happen at most once. */
const idempotencyKey = () =>
  z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe(
      "An optional retry key. Repeating a call with the same key performs the mutation once.",
    );

const resourceMetadata = () =>
  z
    .object({
      description: z
        .string()
        .optional()
        .describe("A short human-readable purpose."),
      tags: z.array(z.string()).optional().describe("Classification labels."),
    })
    .strict()
    .describe("Semantic metadata; send an empty object to clear it.");

/** The read-only annotation set. */
const READ_ONLY: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

/** The write annotation set. */
const WRITE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};

/** The idempotent-write annotation set. */
const UPSERT: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

/** The delete annotation set. */
const DELETE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: false,
};

// ---- Pagination ------------------------------------------------------------

/** Encode an offset as an opaque cursor. */
export function encodeCursor(offset: number): string {
  return Buffer.from(`v1:${offset}`, "utf8").toString("base64url");
}

/** Decode a cursor, refusing anything that is not one of ours. */
export function decodeCursor(value: string | undefined): number {
  if (value === undefined) return 0;
  try {
    const decoded = Buffer.from(value, "base64url").toString("utf8");
    const match = /^v1:(\d+)$/.exec(decoded);
    if (match === null) throw new Error("shape");
    return Number(match[1]);
  } catch {
    throw invalid(
      "The cursor is not valid. Omit it to start from the beginning.",
    );
  }
}

/** Slice one page out of a list and report the next cursor. */
function page<T>(
  items: readonly T[],
  offset: number,
  size: number,
): { items: T[]; nextCursor: string | null } {
  const slice = items.slice(offset, offset + size);
  const next = offset + slice.length;
  return {
    items: slice,
    nextCursor: next < items.length ? encodeCursor(next) : null,
  };
}

// ---- Argument helpers ------------------------------------------------------

/** Read a string argument the schema already validated. */
function stringArg(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== "string" || value === "") {
    throw invalid(`The "${name}" argument is required.`);
  }
  return value;
}

/** Read an optional number argument. */
function numberArg(
  args: Record<string, unknown>,
  name: string,
): number | undefined {
  const value = args[name];
  return typeof value === "number" ? value : undefined;
}

/** Refuse a document larger than its type's ceiling. */
function enforceSize(
  config: McpConfig,
  type: ResourceRecord["type"],
  content: string,
): void {
  const ceiling = config.resourceSizeLimits[type];
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > ceiling) {
    throw invalid(
      `The document is ${bytes} bytes, which exceeds the ${ceiling} byte limit for ${type}.`,
      { kind: "resource_too_large", limit: ceiling, actual: bytes },
    );
  }
}

/** Abort the running tool when the caller has gone away. */
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw invalid("The request was cancelled before the operation completed.");
  }
}

/** Describe a resource in one line, for tool text output. */
function describeResource(resource: {
  id: string;
  path: string;
  type: string;
  revision: number;
}): string {
  return `- ${resource.path} [${resource.type}] id=${resource.id} revision=${resource.revision}`;
}

function describeProposal(proposal: {
  id: string;
  resourceId: string;
  baseRevision: number;
  title: string;
  status: string;
  version: number;
}): string {
  return `- ${proposal.title} [${proposal.status}] id=${proposal.id} resource=${proposal.resourceId} baseRevision=${proposal.baseRevision} version=${proposal.version}`;
}

function proposalDiagnostics(
  diagnostics: Awaited<ReturnType<ArchitecturalProposalService["validate"]>>["diagnostics"],
  resources: Awaited<ReturnType<ArchitecturalProposalService["validate"]>>["index"]["resources"],
): Array<Record<string, unknown>> {
  return diagnostics.map((diagnostic) => {
    const resource = resources.find((entry) => entry.id === diagnostic.resourceId);
    return {
      severity: diagnostic.severity,
      ...(diagnostic.code === undefined ? {} : { code: diagnostic.code }),
      resourceId: diagnostic.resourceId,
      ...(resource === undefined ? {} : { path: resource.path }),
      message: diagnostic.message,
      ...(diagnostic.sourceRange === undefined ? {} : { sourceRange: diagnostic.sourceRange }),
    };
  });
}

/**
 * Resolve an agent-supplied reference to a resource id.
 *
 * A reference is matched as an id first and a path second. The listing that
 * performs the match is itself authorized, so a reference to a resource in
 * another project simply does not resolve — the tool never learns whether it
 * exists.
 */
async function resolveResource(
  toolContext: ToolContext,
  projectIdValue: string,
  reference: string,
  contextId?: string | null,
): Promise<{ id: string; path: string; type: ResourceRecord["type"] }> {
  const resources = await toolContext.catalog.listResources(
    toolContext.context,
    projectIdValue,
    contextId,
  );

  const match =
    resources.find((resource) => resource.id === reference) ??
    resources.find((resource) => resource.path === reference);
  if (!match) {
    throw notFound(
      `No resource "${reference}" in project ${projectIdValue}. Use list_resources to see the ids and paths that exist.`,
    );
  }
  return match;
}

/** The metadata document a project's identity implies, for indexing. */
function metadataFrom(
  resources: ReadonlyArray<{
    id: string;
    path: string;
    type: ResourceRecord["type"];
  }>,
  semanticMessages: ProjectMetadata["semanticMessages"] = [],
): ProjectMetadata {
  const metadata = createEmptyMetadata();
  return {
    ...metadata,
    resources: resources.map((resource) => ({
      id: resource.id,
      path: resource.path,
      type: resource.type,
    })),
    semanticMessages,
  };
}

async function semanticIndex(
  toolContext: ToolContext,
  projectIdValue: string,
  contextId: string | null = null,
): Promise<{ index: ReturnType<typeof buildProjectIndex>; resources: Awaited<ReturnType<ProjectCatalog["listResources"]>> }> {
  throwIfAborted(toolContext.signal);
  const resources = await toolContext.catalog.listResources(toolContext.context, projectIdValue, contextId);
  const semanticMessages = await toolContext.catalog.listSemanticMessages(toolContext.context, projectIdValue, contextId);
  const metadata = { ...metadataFrom(resources), semanticMessages };
  const analyses = [];
  for (const resource of resources.slice(0, MAX_INDEXED_DOCUMENTS)) {
    throwIfAborted(toolContext.signal);
     const { content } = await toolContext.catalog.readResource(toolContext.context, projectIdValue, resource.id, contextId);
    analyses.push(analyzeResource({ id: resource.id, projectId: projectIdValue, path: resource.path, type: resource.type, title: resource.path }, content));
  }
  const perResource = analyses.flatMap((analysis) => analysis.diagnostics);
  const index = buildProjectIndex(projectIdValue, analyses, metadata, (core) => validateProject(core, perResource, metadata));
  return { index, resources };
}

function occurrenceLine(
  source: string,
  name: string,
  step: number | undefined,
): { line: number; kind: "event" | "command" } {
  const ast = analyze(source).ast;
  const occurrences = ast ? semanticMessagesOf(ast).filter((entry) => entry.name === name) : [];
  const occurrence = step === undefined
    ? occurrences.length === 1 ? occurrences[0] : undefined
    : occurrences.find((entry) => entry.step === step);
  if (!occurrence) throw invalid(`No unique Sequence semantic occurrence "${name}"${step === undefined ? "" : ` at step ${step}`}.`);
  return { line: occurrence.range.start.line + 1, kind: occurrence.kind };
}

function eventLine(
  source: string,
  name: string,
): { line: number; kind: "event" | "command" } {
  const parsed = analyzeEventFlow(source);
  const event = eventsOf(parsed.flow).find((entry) => entry.name === name);
  if (!event) throw invalid(`No Event Flow message entity "${name}" exists.`);
  return { line: event.range.start.line, kind: event.kind ?? "event" };
}

function bindSemanticReference(
  source: string,
  type: string,
  name: string,
  step: number | undefined,
  id: string,
  expectedKind: "event" | "command",
): string {
  const lines = source.split("\n");
  const target = type === "event-flow" ? eventLine(source, name) : occurrenceLine(source, name, step);
  if (target.kind !== expectedKind) throw invalid(`Cannot bind ${expectedKind} identity to ${target.kind} occurrence.`);
  if (lines[target.line].includes("messageRef")) throw invalid("The semantic occurrence is already bound.");
  lines[target.line] += ` messageRef ${id}`;
  return lines.join("\n");
}

function unbindSemanticReference(
  source: string,
  type: string,
  name: string,
  step: number | undefined,
): string {
  const lines = source.split("\n");
  const target = type === "event-flow" ? eventLine(source, name) : occurrenceLine(source, name, step);
  if (!lines[target.line].includes("messageRef")) throw invalid("The semantic occurrence is not bound.");
  lines[target.line] = lines[target.line].replace(/\s+messageRef\s+\S+/, "");
  return lines.join("\n");
}

/** Legacy leads only: naming signals are evidence to inspect, never identity. */
async function legacySemanticCandidates(
  toolContext: ToolContext,
  projectIdValue: string,
  resources: Awaited<ReturnType<ProjectCatalog["listResources"]>>,
  contextId: string | null = null,
): Promise<Array<{ resourceId: string; path: string; label: string; evidence: string[] }>> {
  const result: Array<{ resourceId: string; path: string; label: string; evidence: string[] }> = [];
  for (const resource of resources.filter((entry) => entry.type === "sequence-diagram").slice(0, MAX_INDEXED_DOCUMENTS)) {
    const { content } = await toolContext.catalog.readResource(toolContext.context, projectIdValue, resource.id, contextId);
    const ast = analyze(content).ast;
    for (const statement of ast ? walkStatements(ast.statements) : []) {
      if (statement.type !== "message" || statement.semantics || statement.label.trim() === "") continue;
      if (/(?:Event|Command)$/i.test(statement.label.trim()) || /\b(?:publish|consume|dispatch)\b/i.test(statement.label)) {
        result.push({ resourceId: resource.id, path: resource.path, label: statement.label, evidence: ["message text or suffix signal"] });
      }
    }
  }
  return result;
}

/** The search documents for a project, reading each resource's text. */
async function searchDocuments(
  toolContext: ToolContext,
  projectIdValue: string,
  contextId: string | null,
  projectName: string,
  maxDocuments: number,
): Promise<SearchDocument[]> {
  const resources = await toolContext.catalog.listResources(
    toolContext.context,
    projectIdValue,
    contextId,
  );
  const documents: SearchDocument[] = [];
  for (const resource of resources.slice(0, maxDocuments)) {
    throwIfAborted(toolContext.signal);
    const { content } = await toolContext.catalog.readResource(
      toolContext.context,
      projectIdValue,
      resource.id,
      contextId,
    );
    documents.push({
      kind: resource.type === "markdown-document" ? "note" : "diagram",
      id: resource.id,
      projectId: projectIdValue,
      projectName,
      name: resource.path,
      title: resource.path,
      content,
      metadata: resource.metadata,
    });
  }
  return documents;
}

// ---- The catalog -----------------------------------------------------------

/** How many documents one search or validation call will read. */
const MAX_INDEXED_DOCUMENTS = 500;

/** Build every tool the MCP service exposes. */
export function createMcpTools(): McpTool[] {
  return [
    // ---- Level 0: bootstrap -------------------------------------------------

    {
      name: "create_project",
      title: "Create a project",
      description:
        "Create a server project owned by this credential's user. Use this when list_projects is empty; the resulting project is immediately available to this credential.",
      inputSchema: {
        name: z.string().min(1).describe("The new project's name."),
      },
      annotations: { ...WRITE, title: "Create a project" },
      requiredPermissions: ["project:create"],
      async run(args, toolContext) {
        const listing = await toolContext.catalog.createProject(
          toolContext.context,
          {
            name: stringArg(args, "name"),
            workspaceId: await toolContext.catalog.defaultWorkspaceId(
              toolContext.context,
            ),
          },
        );
        return {
          text: `Created project "${listing.project.name}" (id: ${listing.project.id}).`,
          structured: {
            project: {
              id: listing.project.id,
              name: listing.project.name,
              slug: listing.project.slug,
              ownerId: listing.project.ownerId,
              resourceCount: listing.resourceCount,
            },
            role: listing.role,
          },
        };
      },
    },

    // ---- Level 1: discovery ------------------------------------------------

    {
      name: "list_projects",
      title: "List projects",
      description:
        "List every server project this token can see, with the caller's role and resource count. Call this first: the project ids it returns are what every other tool addresses.",
      inputSchema: {},
      annotations: { ...READ_ONLY, title: "List projects" },
      requiredPermissions: ["project:read"],
      async run(_args, toolContext) {
        const listings = await toolContext.catalog.listProjects(
          toolContext.context,
          await toolContext.catalog.defaultWorkspaceId(toolContext.context),
        );
        const text =
          listings.length === 0
            ? "This account has no projects."
            : listings
                .map(
                  (entry) =>
                    `- ${entry.project.name} (id: ${entry.project.id}, role: ${entry.role}, ${entry.resourceCount} resources)`,
                )
                .join("\n");
        return {
          text,
          structured: {
            projects: listings.map((entry) => ({
              id: entry.project.id,
              name: entry.project.name,
              slug: entry.project.slug,
              role: entry.role,
              resourceCount: entry.resourceCount,
            })),
          },
        };
      },
    },

    {
      name: "get_project",
      title: "Get a project",
      description:
        "Read one project's identity and what this token may do in it (`role` and the granted `permissions`). Use it to check whether a write is possible before attempting one.",
       inputSchema: { projectId: projectId(), contextId: z.string().uuid().optional() },
      annotations: { ...READ_ONLY, title: "Get a project" },
      requiredPermissions: ["project:read"],
      async run(args, toolContext) {
        const id = stringArg(args, "projectId");
        const listing = await toolContext.catalog.getProject(
          toolContext.context,
          id,
        );
        const access = await toolContext.catalog.describeAccess(
          toolContext.context,
          id,
        );
        return {
          text: `Project "${listing.project.name}" (id: ${listing.project.id}, role: ${listing.role}, ${listing.resourceCount} resources). Permissions: ${access.permissions.join(", ") || "none"}.`,
          structured: {
            project: {
              id: listing.project.id,
              name: listing.project.name,
              slug: listing.project.slug,
              ownerId: listing.project.ownerId,
              resourceCount: listing.resourceCount,
            },
            access,
          },
        };
      },
    },

    {
      name: "list_private_work_contexts",
      title: "List my private work",
      description: "List private, tentative MY WORK contexts owned by this user inside a shared project. Private contexts are never project-wide.",
       inputSchema: { projectId: projectId(), contextId: z.string().uuid().optional() },
      annotations: { ...READ_ONLY, title: "List my private work" },
      requiredPermissions: ["project:read"],
      async run(args, toolContext) {
        const id = stringArg(args, "projectId");
        const contexts = await toolContext.catalog.listPrivateWorkContexts(toolContext.context, id);
        return { text: contexts.length ? contexts.map((item) => `- ${item.name} (id: ${item.id}, ${item.lifecycle})`).join("\n") : "No private work contexts.", structured: { projectId: id, contexts } };
      },
    },
    {
      name: "get_project_capabilities",
      title: "Get project capabilities",
      description:
        "Read shared advisory governance decisions for this credential, project role, and target state. Capability metadata is not authorization: the application use case re-checks permission, ownership, state, and revisions when called.",
      inputSchema: {
        projectId: projectId(),
        contextId: z.string().uuid().optional().describe("An owned MY WORK context to inspect."),
        proposalId: z.string().uuid().optional().describe("A submitted Architectural Proposal to inspect."),
      },
      annotations: { ...READ_ONLY, title: "Get project capabilities" },
      requiredPermissions: ["project:read"],
      async run(args, toolContext) {
        const id = stringArg(args, "projectId");
        if (args.contextId !== undefined && args.proposalId !== undefined) {
          throw invalid("Provide contextId or proposalId, not both.");
        }
        const project = await toolContext.capabilities.project(toolContext.context, id);
        const target = typeof args.contextId === "string"
          ? { kind: "private-work", capabilities: await toolContext.capabilities.privateWork(toolContext.context, id, args.contextId) }
          : typeof args.proposalId === "string"
            ? { kind: "architectural-proposal", capabilities: await toolContext.capabilities.proposal(toolContext.context, id, args.proposalId) }
            : undefined;
        return {
          text: "Capability decisions are advisory; the application re-checks every operation.",
          structured: { project, ...(target === undefined ? {} : { target }) },
        };
      },
    },
    {
      name: "inspect_effective_knowledge",
      title: "Inspect effective knowledge",
      description: "Inspect the authorized effective view: SHARED plus one owner's private MY WORK context. Provenance remains on each resource.",
      inputSchema: { projectId: projectId(), contextId: z.string().uuid() },
      annotations: { ...READ_ONLY, title: "Inspect effective knowledge" },
      requiredPermissions: ["project:read"],
      async run(args, toolContext) {
        const resources = await toolContext.catalog.listEffectiveResources(toolContext.context, stringArg(args, "projectId"), stringArg(args, "contextId"));
        return { text: `${resources.length} resources in SHARED + MY WORK.`, structured: { resources: resources.map((resource) => ({ ...resource, provenance: resource.contextId ? `private:${resource.contextId}` : "shared" })) } };
      },
    },
    {
      name: "create_private_work_context",
      title: "Create private work",
      description: "Create a private tentative MY WORK context. It belongs only to the authenticated user and does not change SHARED.",
      inputSchema: { projectId: projectId(), name: z.string().min(1), description: z.string().optional() },
      annotations: { ...WRITE, title: "Create private work" },
      requiredPermissions: ["project:read"],
      async run(args, toolContext) {
        const context = await toolContext.catalog.createPrivateWorkContext(toolContext.context, stringArg(args, "projectId"), { name: stringArg(args, "name"), ...(typeof args.description === "string" ? { description: args.description } : {}) });
        return { text: `Created private work "${context.name}" (id: ${context.id}).`, structured: { context } };
      },
    },
    {
      name: "archive_private_work_context",
      title: "Archive private work",
      description: "Archive an owned MY WORK context without exposing it to other project members.",
      inputSchema: { projectId: projectId(), contextId: z.string().uuid() },
      annotations: { ...WRITE, title: "Archive private work" },
      requiredPermissions: ["project:read"],
      async run(args, toolContext) {
        const context = await toolContext.catalog.updatePrivateWorkContext(toolContext.context, stringArg(args, "projectId"), stringArg(args, "contextId"), { lifecycle: "archived" });
        return { text: `Archived private work "${context.name}".`, structured: { context } };
      },
    },
    {
      name: "delete_private_work_context",
      title: "Delete private work",
      description: "Delete an owned MY WORK context and its private resources. SHARED resources and identities are never deleted.",
      inputSchema: { projectId: projectId(), contextId: z.string().uuid() },
      annotations: { ...DELETE, title: "Delete private work" },
      requiredPermissions: ["project:read"],
      async run(args, toolContext) {
        const projectIdValue = stringArg(args, "projectId"); const contextIdValue = stringArg(args, "contextId");
        await toolContext.catalog.deletePrivateWorkContext(toolContext.context, projectIdValue, contextIdValue);
        return { text: "Deleted private work context and its private contents.", structured: { projectId: projectIdValue, contextId: contextIdValue, deleted: true } };
      },
    },

    {
      name: "list_resource_relationships",
      title: "List resource relationships",
      description:
        "List a project's typed resource relationships. A complementary-view relationship is a stable-id link between an existing Sequence and Event Flow that substantially describe the same behavior from different execution and causal perspectives. Prose in descriptions is not a substitute for this relationship.",
       inputSchema: { projectId: projectId(), contextId: z.string().uuid().optional() },
      annotations: { ...READ_ONLY, title: "List resource relationships" },
      requiredPermissions: ["resource:read"],
      async run(args, toolContext) {
        const id = stringArg(args, "projectId");
        const relationships = await toolContext.catalog.listResourceRelationships(
          toolContext.context,
          id,
          typeof args.contextId === "string" ? args.contextId : null,
        );
        return {
          text: relationships.length
            ? `${relationships.length} typed resource relationship(s).`
            : "No typed resource relationships.",
          structured: { projectId: id, relationships },
        };
      },
    },

    {
      name: "create_resource_relationship",
      title: "Create resource relationship",
      description:
        "Create a typed relationship in the caller's owned MY WORK context. contextId is required; this modifies MY WORK only, never SHARED. Publication requires an Architectural Proposal and promotion. Use only for complementary Sequence/Event Flow projections.",
      inputSchema: {
        projectId: projectId(),
         contextId: z.string().uuid().describe("Private MY WORK context id."),
        source: resourceReference().describe("Stable id or project-relative path of the first resource."),
        target: resourceReference().describe("Stable id or project-relative path of the second resource."),
        sourceRole: z.enum(["execution", "causal", "other"]).optional(),
        targetRole: z.enum(["execution", "causal", "other"]).optional(),
      },
      annotations: { ...WRITE, title: "Create resource relationship" },
      requiredPermissions: ["resource:update"],
      async run(args, toolContext) {
        const projectIdValue = stringArg(args, "projectId");
        const contextId = typeof args.contextId === "string" ? args.contextId : null;
        const source = await resolveResource(toolContext, projectIdValue, stringArg(args, "source"), contextId);
        const target = await resolveResource(toolContext, projectIdValue, stringArg(args, "target"), contextId);
        const relationship: ResourceRelationship = {
          kind: "complementary-view",
          sourceId: source.id,
          targetId: target.id,
          ...(typeof args.sourceRole === "string" ? { sourceRole: args.sourceRole as ResourceRelationship["sourceRole"] } : {}),
          ...(typeof args.targetRole === "string" ? { targetRole: args.targetRole as ResourceRelationship["targetRole"] } : {}),
        };
        const created = await toolContext.catalog.createResourceRelationship(
          toolContext.context,
          projectIdValue,
          relationship,
          contextId,
        );
        return {
          text: `Created typed complementary-view relationship between ${source.path} and ${target.path}.`,
          structured: { projectId: projectIdValue, relationship: created },
        };
      },
    },

    {
      name: "get_project_index",
      title: "Get the project index",
      description:
        "Return a bounded project index with resources, relationships and bindable Conceptual/Database entities. Each entity includes its exact EntityAnchor; reuse it verbatim for semantic bindings. Pass contextId to inspect SHARED plus your MY WORK context.",
      inputSchema: {
        projectId: projectId(),
         contextId: z.string().uuid().optional(),
        limit: limit(100, 500),
        cursor: cursor(),
      },
      annotations: { ...READ_ONLY, title: "Get the project index" },
      requiredPermissions: ["resource:read"],
      async run(args, toolContext) {
        const id = stringArg(args, "projectId");
        const contextId = typeof args.contextId === "string" ? args.contextId : null;
        const { index, resources } = await semanticIndex(toolContext, id, contextId);
        const { items, nextCursor } = page(
          resources,
          decodeCursor(
            typeof args.cursor === "string" ? args.cursor : undefined,
          ),
          numberArg(args, "limit") ?? 100,
        );
        const relationships = await toolContext.catalog.listResourceRelationships(
          toolContext.context,
          id,
          contextId,
        );
        const result = {
          projectId: id,
          total: resources.length,
          resources: items.map((resource) => ({
            id: resource.id,
            path: resource.path,
            type: resource.type,
            revision: resource.revision,
            ...(resource.metadata === undefined
              ? {}
              : { metadata: resource.metadata }),
          })),
          entities: (index.entities ?? []).map(({ name, anchor }) => ({
            displayName: name,
            resourceId: anchor.resourceId,
            representation: anchor.representation,
            entityKind: anchor.entityKind,
            identity: anchor.identity,
            anchor,
            resolution: "resolved",
            contextId: contextId ?? "SHARED",
          })),
          relationships,
          nextCursor,
        };
        return {
          text: JSON.stringify(result),
          structured: result,
        };
      },
    },

    {
      name: "list_resources",
      title: "List resources",
      description:
        "List a project's resources with stable identity, semantic metadata and current revision. The revision is what a write must present as `expectedRevision`. Paginated.",
      inputSchema: {
        projectId: projectId(),
         contextId: z.string().uuid().optional(),
        limit: limit(100, 500),
        cursor: cursor(),
        type: z
          .enum(["sequence-diagram", "event-flow", "markdown-document", "conceptual", "database"])
          .optional()
          .describe("Only list resources of this kind."),
      },
      annotations: { ...READ_ONLY, title: "List resources" },
      requiredPermissions: ["resource:read"],
      async run(args, toolContext) {
        const id = stringArg(args, "projectId");
        const wanted = args.type;
        const all = await toolContext.catalog.listResources(
          toolContext.context,
          id,
          typeof args.contextId === "string" ? args.contextId : null,
        );
        const filtered =
          typeof wanted === "string"
            ? all.filter((resource) => resource.type === wanted)
            : all;
        const { items, nextCursor } = page(
          filtered,
          decodeCursor(
            typeof args.cursor === "string" ? args.cursor : undefined,
          ),
          numberArg(args, "limit") ?? 100,
        );
         const relationships = await toolContext.catalog.listResourceRelationships(
           toolContext.context,
           id,
           typeof args.contextId === "string" ? args.contextId : null,
         );
        return {
          text:
            items.length === 0
              ? `Project ${id} has no matching resources.`
              : items.map(describeResource).join("\n"),
          structured: {
            projectId: id,
            total: filtered.length,
            resources: items,
            relationships,
            nextCursor,
          },
        };
      },
    },

    {
      name: "get_project_trajectory",
      title: "Get project trajectory",
      description: "Read the bounded canonical history of every resource in a project.",
      inputSchema: { projectId: projectId(), limit: z.number().int().min(1).max(100).optional(), cursor: z.number().int().min(0).optional() },
      annotations: { ...READ_ONLY, title: "Get project trajectory" },
      requiredPermissions: ["resource:read"],
      async run(args, toolContext) {
        const result = await toolContext.trajectory.getProjectTrajectory(toolContext.context, stringArg(args, "projectId"), { limit: numberArg(args, "limit"), cursor: numberArg(args, "cursor") });
        return { text: `${result.entries.length} trajectory entries.`, structured: result };
      },
    },
    {
      name: "get_resource_trajectory",
      title: "Get resource trajectory",
      description: "Read the bounded canonical history of one resource.",
      inputSchema: { projectId: projectId(), resource: resourceReference(), limit: z.number().int().min(1).max(100).optional(), cursor: z.number().int().min(0).optional() },
      annotations: { ...READ_ONLY, title: "Get resource trajectory" },
      requiredPermissions: ["resource:read"],
      async run(args, toolContext) {
        const project = stringArg(args, "projectId");
        const resource = await resolveResource(toolContext, project, stringArg(args, "resource"));
        const result = await toolContext.trajectory.getResourceTrajectory(toolContext.context, project, resource.id, { limit: numberArg(args, "limit"), cursor: numberArg(args, "cursor") });
        return { text: `${result.entries.length} trajectory entries.`, structured: result };
      },
    },
    {
      name: "list_architectural_proposals",
      title: "List architectural proposals",
      description: "List submitted, team-visible Architectural Proposals without exposing private work contexts.",
       inputSchema: { projectId: projectId(), contextId: z.string().uuid().optional() },
      annotations: { ...READ_ONLY, title: "List architectural proposals" },
      requiredPermissions: ["project:read"],
      async run(args, toolContext) {
        const proposals = await toolContext.architecturalProposals.list(toolContext.context, stringArg(args, "projectId"));
        return { text: proposals.map((proposal) => `${proposal.title} (${proposal.status})`).join("\n") || "No architectural proposals.", structured: { proposals } };
      },
    },
    {
      name: "get_architectural_proposal",
      title: "Get architectural proposal",
      description: "Inspect submitted proposal knowledge, base status, semantic dependencies and relationships.",
      inputSchema: { projectId: projectId(), proposalId: z.string().uuid() },
      annotations: { ...READ_ONLY, title: "Get architectural proposal" },
      requiredPermissions: ["project:read"],
      async run(args, toolContext) {
        const proposal = await toolContext.architecturalProposals.get(toolContext.context, stringArg(args, "projectId"), stringArg(args, "proposalId"));
        const capabilities = await toolContext.capabilities.proposal(toolContext.context, proposal.projectId, proposal.id);
        return { text: `${proposal.title}: ${proposal.resources.length} submitted resources.`, structured: { proposal, capabilities } };
      },
    },
    {
      name: "validate_architectural_proposal",
      title: "Validate architectural proposal",
      description: "Validate a proposal against effective SHARED plus its submitted snapshot, preserving proposal diagnostics.",
      inputSchema: { projectId: projectId(), proposalId: z.string().uuid() },
      annotations: { ...READ_ONLY, title: "Validate architectural proposal" },
      requiredPermissions: ["project:validate"],
      async run(args, toolContext) {
        const project = stringArg(args, "projectId");
        const result = await toolContext.architecturalProposals.validate(toolContext.context, project, stringArg(args, "proposalId"));
        const diagnostics = proposalDiagnostics(result.diagnostics, result.index.resources);
        return { text: `${diagnostics.length} proposal diagnostics.`, structured: { diagnostics } };
      },
    },
    {
      name: "trace_architectural_proposal",
      title: "Trace architectural proposal",
      description: "Trace a bounded semantic message through effective SHARED plus proposal knowledge.",
      inputSchema: {
        projectId: projectId(), proposalId: z.string().uuid(), messageId: z.string().uuid(),
        direction: z.enum(["upstream", "downstream", "both"]).default("both"), maxDepth: z.number().int().min(0).max(50).default(12), maxNodes: z.number().int().min(1).max(500).default(100),
        includeCandidates: z.boolean().default(true), includeRecovery: z.boolean().default(true),
      },
      annotations: { ...READ_ONLY, title: "Trace architectural proposal" },
      requiredPermissions: ["project:read"],
      async run(args, toolContext) {
        const result = await toolContext.architecturalProposals.trace(toolContext.context, stringArg(args, "projectId"), stringArg(args, "proposalId"), {
          messageId: stringArg(args, "messageId"), direction: (args.direction ?? "both") as "upstream" | "downstream" | "both", maxDepth: numberArg(args, "maxDepth") ?? 12, maxNodes: numberArg(args, "maxNodes") ?? 100, includeCandidates: args.includeCandidates !== false, includeRecovery: args.includeRecovery !== false,
        });
        return { text: result.trace ? `Proposal trace contains ${result.trace.nodes.length} nodes.` : "No proposal trace found.", structured: result as unknown as Record<string, unknown> };
      },
    },
    {
      name: "list_architectural_proposal_reviews",
      title: "List proposal reviews",
      description: "Inspect append-only review evidence and its deterministic aggregate status. Reading reviews never changes a Proposal or SHARED.",
      inputSchema: { projectId: projectId(), proposalId: z.string().uuid() },
      annotations: { ...READ_ONLY, title: "List proposal reviews" },
      requiredPermissions: ["project:read"],
      async run(args, toolContext) {
        const reviews = await toolContext.architecturalProposals.reviews(toolContext.context, stringArg(args, "projectId"), stringArg(args, "proposalId"));
        return { text: `${reviews.reviews.length} review(s); status ${reviews.status}.`, structured: { reviews } };
      },
    },
    {
      name: "review_architectural_proposal",
      title: "Review architectural proposal",
       description: "Explicitly record APPROVE or REQUEST_CHANGES for an immutable PROPOSAL. Review is not publication and never mutates SHARED; promotion remains a separate explicit, authorized operation.",
      inputSchema: { projectId: projectId(), proposalId: z.string().uuid(), decision: z.enum(["APPROVE", "REQUEST_CHANGES"]), summary: z.string().max(4000).optional() },
      annotations: { ...WRITE, title: "Review architectural proposal" },
      requiredPermissions: ["resource:update"],
      async run(args, toolContext) {
        const review = await toolContext.architecturalProposals.review(toolContext.context, { projectId: stringArg(args, "projectId"), proposalId: stringArg(args, "proposalId"), decision: args.decision as "APPROVE" | "REQUEST_CHANGES", ...(typeof args.summary === "string" ? { summary: args.summary } : {}) });
        return { text: `Recorded ${review.decision} for proposal ${review.proposalId}; SHARED was not changed.`, structured: { review } };
      },
    },
    {
      name: "submit_architectural_proposal",
      title: "Submit architectural proposal",
       description: "Submit selected owned MY WORK resources as an immutable, non-authoritative PROPOSAL. Submit is not publish and never changes SHARED; promotion requires a separate explicit authorized command.",
      inputSchema: {
        projectId: projectId(), sourcePrivateContextId: z.string().uuid(), resourceIds: z.array(z.string().uuid()), retireResourceIds: z.array(z.string().uuid()).optional(),
        semanticBindings: z.array(z.object({ bindingId: z.string().min(1), operation: z.enum(["ADD", "UPDATE", "REMOVE"]), sourceRevision: z.number().int().min(1).optional(), expectedRevision: z.number().int().min(1).optional(), baseFingerprint: z.string().optional() }).strict()).optional(),
        title: z.string().min(1), description: z.string().optional(),
      },
      annotations: { ...WRITE, title: "Submit architectural proposal" },
      requiredPermissions: ["resource:read", "resource:update"],
      async run(args, toolContext) {
        const proposal = await toolContext.architecturalProposals.submit(toolContext.context, {
          projectId: stringArg(args, "projectId"), sourcePrivateContextId: stringArg(args, "sourcePrivateContextId"),
           resourceIds: args.resourceIds as string[], title: stringArg(args, "title"),
            ...(Array.isArray(args.retireResourceIds) ? { retireResourceIds: args.retireResourceIds as string[] } : {}),
           ...(Array.isArray(args.semanticBindings) ? { semanticBindings: args.semanticBindings as import("../../../src/application/ports/architectural-proposal-repository").ProposalSemanticBindingSelection[] } : {}),
          ...(typeof args.description === "string" ? { description: args.description } : {}),
        });
        return { text: `Submitted ${proposal.title} as ${proposal.id}; SHARED was not changed.`, structured: { proposal } };
      },
    },
    {
      name: "revise_architectural_proposal",
      title: "Revise architectural proposal",
      description: "Create a new immutable proposal snapshot from current owned MY WORK, superseding the old proposal. This does not modify SHARED and reviews never transfer.",
      inputSchema: { projectId: projectId(), proposalId: z.string().uuid(), sourcePrivateContextId: z.string().uuid(), resourceIds: z.array(z.string().uuid()), retireResourceIds: z.array(z.string().uuid()).optional(), semanticBindings: z.array(z.object({ bindingId: z.string().min(1), operation: z.enum(["ADD", "UPDATE", "REMOVE"]), sourceRevision: z.number().int().min(1).optional(), expectedRevision: z.number().int().min(1).optional(), baseFingerprint: z.string().optional() }).strict()).optional(), title: z.string().min(1), description: z.string().optional() },
      annotations: { ...WRITE, title: "Revise architectural proposal" },
      requiredPermissions: ["resource:update"],
      async run(args, toolContext) {
        const proposal = await toolContext.architecturalProposals.revise(toolContext.context, { projectId: stringArg(args, "projectId"), proposalId: stringArg(args, "proposalId"), sourcePrivateContextId: stringArg(args, "sourcePrivateContextId"), resourceIds: args.resourceIds as string[], ...(Array.isArray(args.retireResourceIds) ? { retireResourceIds: args.retireResourceIds as string[] } : {}), ...(Array.isArray(args.semanticBindings) ? { semanticBindings: args.semanticBindings as import("../../../src/application/ports/architectural-proposal-repository").ProposalSemanticBindingSelection[] } : {}), title: stringArg(args, "title"), ...(typeof args.description === "string" ? { description: args.description } : {}) });
        return { text: `Created revised proposal ${proposal.id}; ${proposal.supersedesProposalId} is superseded and SHARED was not changed.`, structured: { proposal } };
      },
    },
    {
      name: "withdraw_architectural_proposal",
      title: "Withdraw architectural proposal",
      description: "Withdraw an open proposal non-destructively. It preserves snapshot and reviews, does not modify SHARED, and prevents future promotion.",
      inputSchema: { projectId: projectId(), proposalId: z.string().uuid(), reason: z.string().optional() },
      annotations: { ...WRITE, title: "Withdraw architectural proposal" },
      requiredPermissions: ["resource:update"],
      async run(args, toolContext) {
        const proposal = await toolContext.architecturalProposals.withdraw(toolContext.context, { projectId: stringArg(args, "projectId"), proposalId: stringArg(args, "proposalId"), ...(typeof args.reason === "string" ? { reason: args.reason } : {}) });
        return { text: `Withdrawn proposal ${proposal.id}; SHARED was not changed.`, structured: { proposal } };
      },
    },
    {
      name: "preview_architectural_proposal_promotion",
      title: "Preview architectural proposal promotion",
       description: "Preview the deterministic promotion plan and blockers without changing SHARED. Preview is not publication; current state is revalidated by PromotionService on execution.",
      inputSchema: { projectId: projectId(), proposalId: z.string().uuid() },
      annotations: { ...READ_ONLY, title: "Preview proposal promotion" },
      requiredPermissions: ["project:read"],
      async run(args, toolContext) {
        const preview = await toolContext.promotion.preview(toolContext.context, stringArg(args, "projectId"), stringArg(args, "proposalId"));
        return { text: JSON.stringify(preview), structured: { preview } };
      },
    },
    {
      name: "promote_architectural_proposal",
      title: "Promote architectural proposal",
       description: "Promote an eligible Architectural Proposal to authoritative SHARED state through PromotionService. Promotion is explicit and independently re-authorized with promotion:execute and the OWNER invariant; approval or capability metadata alone cannot publish.",
      inputSchema: { projectId: projectId(), proposalId: z.string().uuid(), idempotencyKey: z.string().optional() },
      annotations: { ...WRITE, title: "Promote architectural proposal", destructiveHint: true },
      requiredPermissions: ["promotion:execute"],
      async run(args, toolContext) {
        const promotion = await toolContext.promotion.execute(toolContext.context, stringArg(args, "projectId"), stringArg(args, "proposalId"), typeof args.idempotencyKey === "string" ? args.idempotencyKey : undefined);
        return { text: `Promoted proposal ${promotion.proposalId}.`, structured: { promotion } };
      },
    },
    {
      name: "list_change_proposals",
      title: "List change proposals",
      description: "List isolated change proposals for a resource.",
       inputSchema: { projectId: projectId(), contextId: z.string().uuid().optional(), resource: resourceReference() },
      annotations: { ...READ_ONLY, title: "List change proposals" },
      requiredPermissions: ["resource:read"],
      async run(args, toolContext) {
        const project = stringArg(args, "projectId");
        const resource = await resolveResource(
          toolContext,
          project,
           stringArg(args, "resource"),
           typeof args.contextId === "string" ? args.contextId : null,
        );
        const proposals = await toolContext.proposals.list(
          toolContext.context,
          project,
          resource.id,
        );
        return {
          text:
            proposals.map(describeProposal).join("\n") ||
            "No change proposals.",
          structured: { proposals },
        };
      },
    },

    {
      name: "create_change_proposal",
      title: "Create change proposal",
      description:
        "Create a draft proposal initialized from an immutable resource revision.",
      inputSchema: {
        projectId: projectId(),
         contextId: z.string().uuid().describe("Private MY WORK context id."),
        resource: resourceReference(),
        title: z.string().min(1),
        description: z.string().optional(),
        baseRevision: z.number().int().min(1).optional(),
      },
      annotations: { ...WRITE, title: "Create change proposal" },
      requiredPermissions: ["resource:update"],
      async run(args, toolContext) {
        const project = stringArg(args, "projectId");
        const resource = await resolveResource(
          toolContext,
          project,
          stringArg(args, "resource"),
          typeof args.contextId === "string" ? args.contextId : null,
        );
        const proposal = await toolContext.proposals.create(
          toolContext.context,
          project,
          resource.id,
          {
            title: stringArg(args, "title"),
            ...(typeof args.description === "string"
              ? { description: args.description }
              : {}),
            ...(typeof args.baseRevision === "number"
              ? { baseRevision: args.baseRevision }
              : {}),
          },
        );
        return { text: describeProposal(proposal), structured: { proposal } };
      },
    },

    {
      name: "get_change_proposal",
      title: "Get change proposal",
      description:
        "Read a proposal's isolated content, metadata, status and provenance.",
      inputSchema: { proposalId: z.string().uuid() },
      annotations: { ...READ_ONLY, title: "Get change proposal" },
      requiredPermissions: ["resource:read"],
      async run(args, toolContext) {
        const proposal = await toolContext.proposals.get(
          toolContext.context,
          stringArg(args, "proposalId"),
        );
        return { text: describeProposal(proposal), structured: { proposal } };
      },
    },

    {
      name: "get_change_proposal_diff",
      title: "Get change proposal diff",
      description:
        "Compare a proposal's immutable base revision with its candidate state. Returns structured semantic changes, metadata changes, bounded source hunks, diagnostics, and separate canonical staleness information. This is read-only and does not detect conflicts or merge.",
      inputSchema: { proposalId: z.string().uuid() },
      annotations: { ...READ_ONLY, title: "Get change proposal diff" },
      requiredPermissions: ["resource:read"],
      async run(args, toolContext) {
        const diff = await toolContext.proposals.diff(
          toolContext.context,
          stringArg(args, "proposalId"),
        );
        return {
          text: `${diff.summary.semanticChanges} semantic changes; ${diff.summary.sourceHunks} source hunks. Base revision ${diff.baseRevision}, current revision ${diff.currentRevision}${diff.stale ? " (stale)" : ""}.`,
          structured: { ...diff },
        };
      },
    },

    {
      name: "analyze_change_proposal_merge",
      title: "Analyze change proposal merge",
      description:
        "Read-only three-way analysis of a proposal against its immutable base and current canonical revision. Reports staleness, semantic conflicts, diagnostics, and an in-memory candidate when safe; never merges or mutates state.",
      inputSchema: { proposalId: z.string().uuid() },
      annotations: { ...READ_ONLY, title: "Analyze change proposal merge" },
      requiredPermissions: ["resource:read"],
      async run(args, toolContext) {
        const analysis = await toolContext.proposals.analyzeMerge(
          toolContext.context,
          stringArg(args, "proposalId"),
        );
        return {
          text:
            analysis.status !== "ok"
              ? `Merge analysis ${analysis.status}.`
              : `${analysis.stale ? "Stale" : "Fresh"}; ${analysis.autoMergeable ? "auto-mergeable" : `${analysis.conflicts.length} conflict(s)`}.`,
          structured: { ...analysis },
        };
      },
    },

    {
      name: "update_change_proposal",
      title: "Update change proposal",
      description:
        "Edit a draft or open proposal using its proposal-local version.",
      inputSchema: {
        proposalId: z.string().uuid(),
        expectedVersion: z.number().int().min(1),
        proposedContent: z.string().optional(),
        proposedMetadata: resourceMetadata().optional(),
        title: z.string().min(1).optional(),
        description: z.string().optional(),
      },
      annotations: { ...WRITE, title: "Update change proposal" },
      requiredPermissions: ["resource:update"],
      async run(args, toolContext) {
        const proposal = await toolContext.proposals.update(
          toolContext.context,
          stringArg(args, "proposalId"),
          {
            expectedVersion: numberArg(args, "expectedVersion") ?? 0,
            ...(typeof args.proposedContent === "string"
              ? { proposedContent: args.proposedContent }
              : {}),
            ...(args.proposedMetadata === undefined
              ? {}
              : {
                  proposedMetadata: normalizeResourceMetadata(
                    args.proposedMetadata as {
                      description?: string;
                      tags?: string[];
                    },
                  ),
                }),
            ...(typeof args.title === "string" ? { title: args.title } : {}),
            ...(typeof args.description === "string"
              ? { description: args.description }
              : {}),
          },
        );
        return { text: describeProposal(proposal), structured: { proposal } };
      },
    },

    {
      name: "open_change_proposal",
      title: "Open change proposal",
      description:
        "Move a draft proposal to open using its proposal-local version.",
      inputSchema: {
        proposalId: z.string().uuid(),
        expectedVersion: z.number().int().min(1),
      },
      annotations: { ...WRITE, title: "Open change proposal" },
      requiredPermissions: ["resource:update"],
      async run(args, toolContext) {
        const proposal = await toolContext.proposals.open(
          toolContext.context,
          stringArg(args, "proposalId"),
          numberArg(args, "expectedVersion") ?? 0,
        );
        return { text: describeProposal(proposal), structured: { proposal } };
      },
    },

    {
      name: "close_change_proposal",
      title: "Close change proposal",
      description:
        "Close a draft or open proposal using its proposal-local version.",
      inputSchema: {
        proposalId: z.string().uuid(),
        expectedVersion: z.number().int().min(1),
      },
      annotations: { ...WRITE, title: "Close change proposal" },
      requiredPermissions: ["resource:update"],
      async run(args, toolContext) {
        const proposal = await toolContext.proposals.close(
          toolContext.context,
          stringArg(args, "proposalId"),
          numberArg(args, "expectedVersion") ?? 0,
        );
        return { text: describeProposal(proposal), structured: { proposal } };
      },
    },

    {
      name: "get_resource_metadata",
      title: "Get resource metadata",
      description:
        "Read one resource's identity, path, type, semantic metadata and current revision without its contents.",
       inputSchema: { projectId: projectId(), contextId: z.string().uuid().optional(), resource: resourceReference() },
      annotations: { ...READ_ONLY, title: "Get resource metadata" },
      requiredPermissions: ["resource:read"],
      async run(args, toolContext) {
        const id = stringArg(args, "projectId");
        const resolved = await resolveResource(
          toolContext,
          id,
           stringArg(args, "resource"),
            typeof args.contextId === "string" ? args.contextId : null,
        );
        const resource = await toolContext.catalog.getResource(
          toolContext.context,
          id,
           resolved.id,
            typeof args.contextId === "string" ? args.contextId : null,
        );
        return {
          text: describeResource(resource),
          structured: { resource },
        };
      },
    },

    {
      name: "update_resource_metadata",
      title: "Update resource metadata",
      description:
        "Replace a resource's semantic description and tags without changing its text. Send the revision you read; an empty metadata object clears both fields. Retries can use an idempotency key.",
      inputSchema: {
        projectId: projectId(),
         contextId: z.string().uuid().describe("Private MY WORK context id."),
        resource: resourceReference(),
        metadata: resourceMetadata(),
        expectedRevision: z
          .number()
          .int()
          .min(1)
          .describe("The revision you last read."),
        idempotencyKey: idempotencyKey(),
      },
      annotations: { ...UPSERT, title: "Update resource metadata" },
      requiredPermissions: ["resource:update"],
      async run(args, toolContext) {
        const id = stringArg(args, "projectId");
        const resolved = await resolveResource(
          toolContext,
          id,
          stringArg(args, "resource"),
          typeof args.contextId === "string" ? args.contextId : null,
        );
        const current = await toolContext.catalog.readResource(
          toolContext.context,
          id,
           resolved.id,
           typeof args.contextId === "string" ? args.contextId : null,
         );
        const resource = await toolContext.catalog.updateResource(
          toolContext.context,
          id,
          resolved.id,
          {
            content: current.content,
            metadata: normalizeResourceMetadata(
              args.metadata as { description?: string; tags?: string[] },
            ),
            expectedRevision: numberArg(args, "expectedRevision") ?? 0,
            ...(typeof args.contextId === "string" ? { contextId: args.contextId } : {}),
            ...(typeof args.idempotencyKey === "string"
              ? { idempotencyKey: args.idempotencyKey }
              : {}),
          },
        );
        return {
          text: `Updated metadata for ${resource.path}; it is now at revision ${resource.revision}.`,
          structured: { resource },
        };
      },
    },

    {
      name: "search_project",
      title: "Search a project",
      description:
        "Search a project's documents and metadata with bounded snippets — never whole files. Supports plain text plus `tag:payments`, `type:diagram`, and the existing project/kind/participant filters. Paginated.",
      inputSchema: {
        projectId: projectId(),
          contextId: z.string().uuid().optional(),
         query: z
          .string()
          .describe(
            "Plain text or filters such as `tag:payments`, `type:diagram`, `kind:note`, `project:name`, and `participant:Name`.",
          ),
        limit: limit(50, 200),
        cursor: cursor(),
      },
      annotations: { ...READ_ONLY, title: "Search a project" },
      requiredPermissions: ["project:search"],
      async run(args, toolContext) {
        const id = stringArg(args, "projectId");
        const contextId = typeof args.contextId === "string" ? args.contextId : null;
        const offset = decodeCursor(
          typeof args.cursor === "string" ? args.cursor : undefined,
        );
        const size = numberArg(args, "limit") ?? 50;
        const listing = await toolContext.catalog.getProject(
          toolContext.context,
          id,
        );
        const documents = await searchDocuments(
          toolContext,
          id,
          contextId,
          listing.project.name,
          MAX_INDEXED_DOCUMENTS,
        );
        const matches = searchProject(
          documents,
          parseSearchQuery(stringArg(args, "query")),
          { limit: offset + size },
        );
        const { items, nextCursor } = page(matches, offset, size);
        return {
          text:
            items.length === 0
              ? "No matches."
              : items
                  .map(
                    (match) =>
                      `- ${match.name}:${match.line} — ${match.excerpt}`,
                  )
                  .join("\n"),
          structured: {
            results: items.map((match) => ({
              resourceId: match.id,
              path: match.name,
              line: match.line,
              column: match.column,
              snippet: match.excerpt,
              description: match.metadata?.description,
              tags: match.metadata?.tags,
              matchedFields: match.matchedFields,
            })),
            nextCursor,
          },
        };
      },
    },

    // ---- Level 2: primitive resource operations ----------------------------

    {
      name: "read_resource",
      title: "Read a resource",
      description:
        "Read one resource's full text together with its identity and current revision. Always read before updating, so you hold the revision the write must present.",
      inputSchema: { projectId: projectId(), contextId: z.string().uuid().optional(), resource: resourceReference() },
      annotations: { ...READ_ONLY, title: "Read a resource" },
      requiredPermissions: ["resource:read"],
      async run(args, toolContext) {
        const id = stringArg(args, "projectId");
        const resolved = await resolveResource(
          toolContext,
          id,
          stringArg(args, "resource"),
          typeof args.contextId === "string" ? args.contextId : null,
        );
        const { resource, content } = await toolContext.catalog.readResource(
          toolContext.context,
          id,
          resolved.id,
          typeof args.contextId === "string" ? args.contextId : null,
        );
        return {
          text: `${resource.path} [${resource.type}] id=${resource.id} revision=${resource.revision}\n\n${content}`,
          structured: { resource, content },
        };
      },
    },

    {
      name: "create_resource",
      title: "Create a resource",
      description:
        "Create a new document in the caller's owned MY WORK context. contextId is required; this modifies MY WORK only, never SHARED. Publication requires an Architectural Proposal and promotion. Send an idempotencyKey for safe retries.",
      inputSchema: {
        projectId: projectId(),
         contextId: z.string().uuid().describe("Private MY WORK context id."),
        path: z
          .string()
          .min(1)
          .describe(
            'The project-relative path, for example "checkout.seq" or "notes/overview.md". No absolute paths and no "..".',
          ),
        type: z
          .enum(["sequence-diagram", "event-flow", "markdown-document", "conceptual", "database"])
          .describe("What is being created."),
        content: z.string().describe("The full text of the new resource."),
        idempotencyKey: idempotencyKey(),
      },
      annotations: { ...WRITE, title: "Create a resource" },
      requiredPermissions: ["resource:create"],
      async run(args, toolContext) {
        const id = stringArg(args, "projectId");
        const type = args.type as ResourceRecord["type"];
        const content = typeof args.content === "string" ? args.content : "";
        enforceSize(toolContext.config, type, content);
        const resource = await toolContext.catalog.createResource(
          toolContext.context,
          id,
          {
            path: stringArg(args, "path"),
            type,
            content,
            ...(typeof args.contextId === "string" ? { contextId: args.contextId } : {}),
            ...(typeof args.idempotencyKey === "string"
              ? { idempotencyKey: args.idempotencyKey }
              : {}),
          },
        );
        return {
          text: `Created ${resource.path} (id: ${resource.id}, revision: ${resource.revision}).`,
          structured: { resource },
        };
      },
    },

    {
      name: "update_resource",
      title: "Update a resource",
      description:
        "Replace a resource in the caller's owned MY WORK context. contextId is required; this modifies MY WORK only, never SHARED. Publication requires an Architectural Proposal and promotion. expectedRevision must be the revision you last read; re-read on conflict.",
      inputSchema: {
        projectId: projectId(),
           contextId: z.string().uuid().describe("Private MY WORK context id."),
        resource: resourceReference(),
        content: z.string().describe("The complete new text."),
        expectedRevision: z
          .number()
          .int()
          .min(1)
          .describe(
            "The revision you last read, from read_resource or get_resource_metadata.",
          ),
        idempotencyKey: idempotencyKey(),
      },
      annotations: { ...WRITE, title: "Update a resource" },
      requiredPermissions: ["resource:update"],
      async run(args, toolContext) {
        const id = stringArg(args, "projectId");
        const resolved = await resolveResource(
          toolContext,
          id,
          stringArg(args, "resource"),
          typeof args.contextId === "string" ? args.contextId : null,
        );
        const content = typeof args.content === "string" ? args.content : "";
        enforceSize(toolContext.config, resolved.type, content);
        const resource = await toolContext.catalog.updateResource(
          toolContext.context,
          id,
          resolved.id,
          {
            content,
            expectedRevision: numberArg(args, "expectedRevision") ?? 0,
            ...(typeof args.contextId === "string" ? { contextId: args.contextId } : {}),
            ...(typeof args.idempotencyKey === "string"
              ? { idempotencyKey: args.idempotencyKey }
              : {}),
          },
        );
        return {
          text: `Updated ${resource.path}; it is now at revision ${resource.revision}.`,
          structured: { resource },
        };
      },
    },

    {
      name: "move_resource",
      title: "Move or rename a resource",
      description:
        "Move a resource within the caller's owned MY WORK context. contextId is required; this modifies MY WORK only, never SHARED. Publication requires an Architectural Proposal and promotion. expectedRevision is required and stale writes are rejected.",
      inputSchema: {
        projectId: projectId(),
         contextId: z.string().uuid().describe("Private MY WORK context id."),
        resource: resourceReference(),
        path: z.string().min(1).describe("The new project-relative path."),
        expectedRevision: z
          .number()
          .int()
          .min(1)
          .describe("The revision you last read."),
        idempotencyKey: idempotencyKey(),
      },
      annotations: { ...WRITE, title: "Move or rename a resource" },
      requiredPermissions: ["resource:move"],
      async run(args, toolContext) {
        const id = stringArg(args, "projectId");
        const resolved = await resolveResource(
          toolContext,
          id,
          stringArg(args, "resource"),
          typeof args.contextId === "string" ? args.contextId : null,
        );
        const resource = await toolContext.catalog.moveResource(
          toolContext.context,
          id,
          resolved.id,
          {
            path: stringArg(args, "path"),
            expectedRevision: numberArg(args, "expectedRevision") ?? 0,
            ...(typeof args.contextId === "string" ? { contextId: args.contextId } : {}),
            ...(typeof args.idempotencyKey === "string"
              ? { idempotencyKey: args.idempotencyKey }
              : {}),
          },
        );
        return {
          text: `Moved to ${resource.path}; it is now at revision ${resource.revision}.`,
          structured: { resource },
        };
      },
    },

    {
      name: "delete_resource",
      title: "Delete a resource",
      description:
        "Delete a resource from the caller's owned MY WORK context. contextId is required; this modifies MY WORK only, never SHARED. SHARED retirement requires an Architectural Proposal and promotion. Requires confirm: true.",
      inputSchema: {
        projectId: projectId(),
        contextId: z.string().uuid().describe("Private MY WORK context id."),
        resource: resourceReference(),
        confirm: z.boolean().describe("Must be true to actually delete."),
        idempotencyKey: idempotencyKey(),
      },
      annotations: { ...DELETE, title: "Delete a resource" },
      requiredPermissions: ["resource:delete"],
      async run(args, toolContext) {
        const id = stringArg(args, "projectId");
        const resolved = await resolveResource(
          toolContext,
          id,
          stringArg(args, "resource"),
          typeof args.contextId === "string" ? args.contextId : null,
        );
        const resource = await toolContext.catalog.getResource(
          toolContext.context,
          id,
          resolved.id,
          typeof args.contextId === "string" ? args.contextId : null,
        );
        if (args.confirm !== true) {
          throw invalid(
              `Refusing to retire "${resource.path}" without confirmation. Call delete_resource again with confirm: true.`,
          );
        }
        await toolContext.catalog.deleteResource(
          toolContext.context,
          id,
          resolved.id,
          {
            ...(typeof args.contextId === "string" ? { contextId: args.contextId } : {}),
            ...(typeof args.idempotencyKey === "string"
              ? { idempotencyKey: args.idempotencyKey }
              : {}),
          },
        );
        return {
          text: `Retired ${resource.path} (id: ${resource.id}).`,
          structured: { retired: resource },
        };
      },
    },

    // ---- Level 3: semantic tools ------------------------------------------

    {
      name: "read_diagram",
      title: "Read a sequence diagram",
      description:
        "Read a sequence diagram and return its title, lifelines, message count and any syntax or semantic problems, without making you parse the DSL. Prefer this over read_resource when you want to understand a diagram.",
       inputSchema: { projectId: projectId(), contextId: z.string().uuid().optional(), resource: resourceReference() },
      annotations: { ...READ_ONLY, title: "Read a sequence diagram" },
      requiredPermissions: ["resource:read"],
      async run(args, toolContext) {
        const id = stringArg(args, "projectId");
        const resolved = await resolveResource(
          toolContext,
          id,
           stringArg(args, "resource"),
           typeof args.contextId === "string" ? args.contextId : null,
        );
        if (resolved.type !== "sequence-diagram") {
          throw invalid(`"${resolved.path}" is not a sequence diagram.`);
        }
        const { resource, content } = await toolContext.catalog.readResource(
          toolContext.context,
          id,
          resolved.id,
          typeof args.contextId === "string" ? args.contextId : null,
        );
        const { ast, diagnostics } = analyze(content);
        return {
          text: `${resource.path} — title "${diagramTitle(content) ?? "(none)"}", ${ast?.participants.length ?? 0} lifelines, ${diagnostics.length} diagnostics.`,
          structured: {
            resource,
            title: diagramTitle(content) ?? null,
            participants: (ast?.participants ?? []).map((p) => p.id),
            statements: ast?.statements.length ?? 0,
            semanticMessages: ast ? semanticMessagesOf(ast) : [],
            diagnostics: diagnostics.map((diagnostic) => ({
              severity: diagnostic.severity,
              message: diagnostic.message,
              code: String(diagnostic.code),
            })),
            content,
          },
        };
      },
    },

    {
      name: "upsert_sequence_diagram",
      title: "Create or replace a sequence diagram",
      description:
        "Create a diagram at `path`, or replace the one already there when `expectedRevision` matches. The text is parsed and validated first: invalid DSL is never written, and the problems are returned instead. Prefer this over create_resource/update_resource for agent workflows; it is idempotent, so a retry is safe.",
      inputSchema: {
        projectId: projectId(),
         contextId: z.string().uuid().describe("Private MY WORK context id."),
        path: z
          .string()
          .min(1)
          .describe('Project-relative path, for example "checkout.seq".'),
        content: z.string().describe("The complete DSL text."),
        expectedRevision: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe(
            "The revision you last read. Required when the document already exists.",
          ),
        idempotencyKey: idempotencyKey(),
      },
      annotations: { ...UPSERT, title: "Upsert a sequence diagram" },
      requiredPermissions: ["resource:create", "resource:update"],
      async run(args, toolContext) {
        const id = stringArg(args, "projectId");
        const path = stringArg(args, "path");
        const content = typeof args.content === "string" ? args.content : "";
        enforceSize(toolContext.config, "sequence-diagram", content);
        const { diagnostics } = analyze(content);
        const errors = diagnostics.filter(
          (diagnostic) => diagnostic.severity === "error",
        );
        if (errors.length > 0) {
          throw invalid(
            `The diagram was not written: ${errors.length} error(s).\n${errors
              .map((diagnostic) => `- ${diagnostic.message}`)
              .join("\n")}`,
            {
              kind: "validation_failed",
              diagnostics: errors.map((diagnostic) => ({
                message: diagnostic.message,
                code: String(diagnostic.code),
              })),
            },
          );
        }
        return upsertByPath(toolContext, {
          projectId: id,
          path,
          type: "sequence-diagram",
          content,
          ...(typeof args.contextId === "string" ? { contextId: args.contextId } : {}),
          ...(numberArg(args, "expectedRevision") === undefined
            ? {}
            : { expectedRevision: numberArg(args, "expectedRevision") }),
           ...(typeof args.idempotencyKey === "string"
             ? { idempotencyKey: args.idempotencyKey }
             : {}),
        });
      },
    },

    {
      name: "upsert_event_flow",
      title: "Create or replace an event flow",
      description:
        "Create or replace an event-flow document. Use explicit causal lines: `handler H [in Service]`, `Event handled by H`, `H causes ResultingMessage`, and `effect id on H [kind kind]: Description`; event metadata such as `provenance: external|internal|unknown` belongs inside the event block. The complete text is validated, including causal references, before it is persisted; validation errors include diagnostics and nothing is written. The operation is idempotent.",
      inputSchema: {
        projectId: projectId(),
         contextId: z.string().uuid().describe("Private MY WORK context id."),
        path: z
          .string()
          .min(1)
          .describe('Project-relative path, for example "payments.eventseq".'),
        content: z.string().describe("The complete event-flow text."),
        expectedRevision: z.number().int().min(1).optional(),
        idempotencyKey: idempotencyKey(),
      },
      annotations: { ...UPSERT, title: "Upsert an event flow" },
      requiredPermissions: ["resource:create", "resource:update"],
      async run(args, toolContext) {
        const id = stringArg(args, "projectId");
        const path = stringArg(args, "path");
        const content = typeof args.content === "string" ? args.content : "";
        enforceSize(toolContext.config, "event-flow", content);
        const { diagnostics } = analyzeEventFlow(content);
        const errors = diagnostics.filter(
          (diagnostic) => diagnostic.severity === "error",
        );
        if (errors.length > 0) {
          throw invalid(
            `The event flow was not written: ${errors.length} error(s).\n${errors
              .map((diagnostic) => `- ${diagnostic.message}`)
              .join("\n")}`,
            {
              kind: "validation_failed",
              diagnostics: errors.map((diagnostic) => ({
                message: diagnostic.message,
                code: String(diagnostic.code),
              })),
            },
          );
        }
        return upsertByPath(toolContext, {
          projectId: id,
          path,
          type: "event-flow",
          content,
          ...(typeof args.contextId === "string" ? { contextId: args.contextId } : {}),
          ...(numberArg(args, "expectedRevision") === undefined
            ? {}
            : { expectedRevision: numberArg(args, "expectedRevision") }),
          ...(typeof args.idempotencyKey === "string"
            ? { idempotencyKey: args.idempotencyKey }
            : {}),
        });
      },
    },

    {
      name: "render_diagram",
      title: "Render a diagram to SVG",
      description:
        "Render a stored sequence diagram or event flow to an SVG document string. Bounded by the render deadline; prefer this over asking for the SVG through a browser.",
      inputSchema: {
        projectId: projectId(),
         contextId: z.string().uuid().describe("Private MY WORK context id."),
        resource: resourceReference(),
      },
      annotations: { ...READ_ONLY, title: "Render a diagram" },
      requiredPermissions: ["diagram:render"],
      async run(args, toolContext) {
        throwIfAborted(toolContext.signal);
        const id = stringArg(args, "projectId");
        const resolved = await resolveResource(
          toolContext,
          id,
          stringArg(args, "resource"),
          typeof args.contextId === "string" ? args.contextId : null,
        );
        const { resource, content } = await toolContext.catalog.readResource(
          toolContext.context,
          id,
           resolved.id,
           typeof args.contextId === "string" ? args.contextId : null,
         );
        throwIfAborted(toolContext.signal);
        const svg =
          resource.type === "event-flow"
            ? eventFlowSourceToSvg(content)
            : diagramToSvg(content);
        return {
          text: `Rendered ${resource.path} (${svg.length} bytes of SVG).`,
          structured: { resource, svg },
        };
      },
    },

    {
       name: "read_documentation",
      title: "Read a markdown document",
      description:
        "Read a markdown document's text and its heading outline. Prefer this over read_resource for documentation, because it also reports the structure.",
       inputSchema: { projectId: projectId(), contextId: z.string().uuid().optional(), resource: resourceReference() },
      annotations: { ...READ_ONLY, title: "Read documentation" },
      requiredPermissions: ["resource:read"],
      async run(args, toolContext) {
        const id = stringArg(args, "projectId");
        const resolved = await resolveResource(
          toolContext,
          id,
           stringArg(args, "resource"),
           typeof args.contextId === "string" ? args.contextId : null,
        );
        if (resolved.type !== "markdown-document") {
          throw invalid(`"${resolved.path}" is not a markdown document.`);
        }
        const { resource, content } = await toolContext.catalog.readResource(
          toolContext.context,
          id,
           resolved.id,
           typeof args.contextId === "string" ? args.contextId : null,
         );
        const headings = content
          .split("\n")
          .filter((line) => /^#{1,6}\s+\S/.test(line))
          .map((line) => line.trim());
        return {
          text: `${resource.path} — ${headings.length} heading(s).`,
          structured: { resource, headings, content },
        };
      },
    },

    {
      name: "upsert_documentation",
      title: "Create or replace a markdown document",
      description:
        "Create or replace a markdown document at `path`. When the document already exists, `expectedRevision` is required and must be the revision you last read. Idempotent, so a retry with the same key is safe.",
      inputSchema: {
        projectId: projectId(),
         contextId: z.string().uuid().describe("Private MY WORK context id."),
        path: z
          .string()
          .min(1)
          .describe('Project-relative path, for example "docs/overview.md".'),
        content: z.string().describe("The complete markdown text."),
        expectedRevision: z.number().int().min(1).optional(),
        idempotencyKey: idempotencyKey(),
      },
      annotations: { ...UPSERT, title: "Upsert documentation" },
      requiredPermissions: ["resource:create", "resource:update"],
      async run(args, toolContext) {
        const id = stringArg(args, "projectId");
        const path = stringArg(args, "path");
        const content = typeof args.content === "string" ? args.content : "";
        enforceSize(toolContext.config, "markdown-document", content);
        return upsertByPath(toolContext, {
          projectId: id,
          path,
          type: "markdown-document",
          content,
          ...(typeof args.contextId === "string" ? { contextId: args.contextId } : {}),
          ...(numberArg(args, "expectedRevision") === undefined
            ? {}
            : { expectedRevision: numberArg(args, "expectedRevision") }),
          ...(typeof args.idempotencyKey === "string"
            ? { idempotencyKey: args.idempotencyKey }
            : {}),
        });
      },
    },

    {
      name: "list_semantic_messages",
      title: "List semantic message identities",
      description: "List explicit project-scoped semantic message identities and their stable display data. Equal names without explicit references remain candidates only.",
      inputSchema: { projectId: projectId(), contextId: z.string().uuid().optional() },
      annotations: { ...READ_ONLY, title: "List semantic message identities" },
      requiredPermissions: ["project:read"],
      async run(args, toolContext) {
         const messages = await toolContext.catalog.listSemanticMessages(toolContext.context, stringArg(args, "projectId"), typeof args.contextId === "string" ? args.contextId : null);
        return { text: messages.length ? JSON.stringify(messages) : "No semantic message identities.", structured: { messages } };
      },
    },
    {
      name: "list_semantic_bindings",
      title: "List semantic bindings",
      description: "List explicit active Semantic Bindings in SHARED, or SHARED plus your MY WORK context when contextId is supplied. Matching names are discovery hints, never evidence. Semantic bindings are separate from SemanticMessageIdentity/messageRef.",
      inputSchema: { projectId: projectId(), contextId: z.string().uuid().optional() },
      annotations: { ...READ_ONLY, title: "List semantic bindings" },
      requiredPermissions: ["resource:read"],
      async run(args, toolContext) {
        const bindings = await toolContext.catalog.listSemanticBindings(toolContext.context, stringArg(args, "projectId"), typeof args.contextId === "string" ? args.contextId : null);
        return { text: bindings.length ? `${bindings.length} explicit semantic binding(s).` : "No documented explicit binding.", structured: { bindings, candidates: { available: false }, semanticMessages: "separate" } };
      },
    },
    {
      name: "get_semantic_binding",
      title: "Get semantic binding",
      description: "Get one explicitly stored binding. Resolution is exact by stable resource and entity identity; no name repair is performed.",
      inputSchema: { projectId: projectId(), contextId: z.string().uuid().optional(), bindingId: z.string().min(1) },
      annotations: { ...READ_ONLY, title: "Get semantic binding" },
      requiredPermissions: ["resource:read"],
      async run(args, toolContext) {
        const binding = await toolContext.catalog.getSemanticBinding(toolContext.context, stringArg(args, "projectId"), typeof args.contextId === "string" ? args.contextId : null, stringArg(args, "bindingId"));
        return { text: `Binding ${binding.id}: ${binding.left.representation} -> ${binding.right.representation} (${binding.relation}).`, structured: { binding } };
      },
    },
    {
      name: "get_semantic_bindings_for_entity",
      title: "Get bindings for exact entity",
      description: "Find explicit bindings for an exact EntityAnchor. It does not search or match by display name; no match means No documented explicit binding.",
      inputSchema: { projectId: projectId(), contextId: z.string().uuid().optional(), anchor: entityAnchorSchema },
      annotations: { ...READ_ONLY, title: "Get bindings for exact entity" },
      requiredPermissions: ["resource:read"],
      async run(args, toolContext) {
        const id = stringArg(args, "projectId");
        const contextId = typeof args.contextId === "string" ? args.contextId : null;
        const anchor = args.anchor as import("../../../src/domain/workspace/semantic-binding").EntityAnchor;
        const resources = await toolContext.catalog.listResources(toolContext.context, id, contextId);
        const messages = await toolContext.catalog.listSemanticMessages(toolContext.context, id, contextId);
        const metadata = { ...metadataFrom(resources), semanticMessages: messages };
        const analyses = await Promise.all(resources.slice(0, MAX_INDEXED_DOCUMENTS).map(async resource => {
          const { content } = await toolContext.catalog.readResource(toolContext.context, id, resource.id, contextId);
          return analyzeResource({ id: resource.id, projectId: id, path: resource.path, type: resource.type, title: resource.path }, content);
        }));
        const index = buildProjectIndex(id, analyses, metadata, () => []);
        const { getSemanticBindingsForEntity } = await import("../../../src/application/semantic-binding-query");
        const bindings = await toolContext.catalog.listSemanticBindings(toolContext.context, id, contextId);
        const resolved = getSemanticBindingsForEntity(anchor, bindings, index);
        return { text: resolved.length ? `${resolved.length} explicit binding(s) for exact anchor.` : "No documented explicit binding.", structured: { bindings: resolved, candidates: { available: false }, unresolved: resolved.filter(entry => entry.resolution.left !== "resolved" || entry.resolution.right !== "resolved") } };
      },
    },
    {
      name: "create_semantic_binding",
      title: "Create semantic binding in MY WORK",
      description: "Create an explicit binding in the caller's owned MY WORK. Copy left/right anchors from get_project_index.entities. relation is represents-in; evidence requires version 1, rationale and at least one internal or external evidence item. Name matches are discovery hints only, never evidence. Publication requires proposal and explicit promotion.",
      inputSchema: { projectId: projectId(), contextId: z.string().uuid().describe("Owned MY WORK context id used for entity discovery and binding creation."), binding: semanticBindingInputSchema.describe("Binding with exact left/right anchors, supported relation and required evidence.") },
      annotations: { ...WRITE, title: "Create semantic binding" }, requiredPermissions: ["resource:update"],
      async run(args, toolContext) {
        const parsed = semanticBindingInputSchema.safeParse(args.binding);
        if (!parsed.success) throw invalid("Invalid semantic binding payload.", { fieldErrors: parsed.error.issues.map(issue => ({ field: `binding.${issue.path.join(".")}`, message: issue.message })) });
        const binding = await toolContext.catalog.createSemanticBinding(toolContext.context, stringArg(args, "projectId"), stringArg(args, "contextId"), parsed.data as never);
        return { text: `Created explicit binding ${binding.id} in MY WORK; SHARED was not changed.`, structured: { binding } };
      },
    },
    {
      name: "update_semantic_binding",
      title: "Update semantic binding in MY WORK",
      description: "Update an existing MY WORK binding with optimistic expectedRevision. A stale revision is rejected. This never writes SHARED.",
      inputSchema: { projectId: projectId(), contextId: z.string().uuid().describe("Owned MY WORK context id."), binding: semanticBindingUpdateSchema.describe("Complete binding state; left/right anchors and evidence use the same schema as create_semantic_binding."), expectedRevision: z.number().int().min(1).describe("Revision last read from get_semantic_binding; stale revisions return conflict.") },
      annotations: { ...WRITE, title: "Update semantic binding" }, requiredPermissions: ["resource:update"],
      async run(args, toolContext) {
        const parsed = semanticBindingUpdateSchema.safeParse(args.binding);
        if (!parsed.success) throw invalid("Invalid semantic binding payload.", { fieldErrors: parsed.error.issues.map(issue => ({ field: `binding.${issue.path.join(".")}`, message: issue.message })) });
        const expectedRevision = numberArg(args, "expectedRevision");
        if (expectedRevision === undefined) throw invalid("expectedRevision is required.", { field: "expectedRevision" });
        const binding = await toolContext.catalog.updateSemanticBinding(toolContext.context, stringArg(args, "projectId"), stringArg(args, "contextId"), parsed.data as never, expectedRevision);
        return { text: `Updated binding ${binding.id} to revision ${binding.revision}; SHARED was not changed.`, structured: { binding } };
      },
    },
    {
      name: "delete_semantic_binding",
      title: "Delete semantic binding from MY WORK",
      description: "Remove a binding from the caller's MY WORK using expectedRevision. This does not delete or alter a SHARED binding; authoritative retirement uses proposal/promotion.",
      inputSchema: { projectId: projectId(), contextId: z.string().uuid(), bindingId: z.string().min(1), expectedRevision: z.number().int().min(1) },
      annotations: { ...DELETE, title: "Delete semantic binding" }, requiredPermissions: ["resource:update"],
      async run(args, toolContext) {
        const binding = await toolContext.catalog.removeSemanticBinding(toolContext.context, stringArg(args, "projectId"), stringArg(args, "contextId"), stringArg(args, "bindingId"), numberArg(args, "expectedRevision")!);
        return { text: `Removed binding ${binding.id} from MY WORK; SHARED was not changed.`, structured: { binding } };
      },
    },
    {
      name: "get_semantic_message",
      title: "Get semantic message trace",
      description: "Inspect one explicit semantic message identity, its authoritative Sequence occurrences, and Event Flow representations. Names are never used as identity.",
       inputSchema: { projectId: projectId(), contextId: z.string().uuid().optional(), messageId: z.string().min(1) },
      annotations: { ...READ_ONLY, title: "Get semantic message trace" },
      requiredPermissions: ["project:search"],
      async run(args, toolContext) {
         const id = stringArg(args, "projectId");
         const contextId = typeof args.contextId === "string" ? args.contextId : null;
         const indexed = await semanticIndex(toolContext, id, contextId);
        const trace = traceSemanticMessage(indexed.index, stringArg(args, "messageId"));
        const downstream = [];
        for (const entity of trace.eventFlowEntities) {
           const resource = await toolContext.catalog.readResource(toolContext.context, id, entity.resourceId, contextId);
          const flow = analyzeEventFlow(resource.content).flow;
          for (const handler of handlersFor(flow, entity.name)) {
            downstream.push({ resourceId: entity.resourceId, handler: handler.id, messages: resultingEventsFor(flow, handler.id), effects: effectsFor(flow, handler.id) });
          }
        }
        const result = { ...trace, downstream };
        return { text: JSON.stringify(result), structured: result };
      },
    },
    {
      name: "trace_architecture",
      title: "Trace architecture",
      description: "Trace authoritative architecture upstream, downstream, or both from a semantic message identity or an exact indexed occurrence. Use resource, name, and optional step when no messageId is available; unbound and legacy starts return structured candidate or unknown resolution instead of inferred connections.",
      inputSchema: {
        projectId: projectId(),
        messageId: z.string().min(1).optional(),
        resource: z.string().min(1).optional(),
        name: z.string().min(1).optional(),
        step: z.number().int().min(1).optional(),
        direction: z.enum(["upstream", "downstream", "both"]).optional(),
        maxDepth: z.number().int().min(0).max(32).optional(),
        maxNodes: z.number().int().min(1).max(5000).optional(),
        includeCandidates: z.boolean().optional(),
        includeRecovery: z.boolean().optional(),
      },
      annotations: { ...READ_ONLY, title: "Trace architecture" },
      requiredPermissions: ["project:search"],
      async run(args, toolContext) {
        const projectIdValue = stringArg(args, "projectId");
        const indexed = await semanticIndex(toolContext, projectIdValue);
        const messageId = typeof args.messageId === "string" ? args.messageId : undefined;
        const resource = typeof args.resource === "string" ? args.resource : undefined;
        const name = typeof args.name === "string" ? args.name : undefined;
        if (messageId && (resource || name)) throw invalid("Provide messageId or resource and name, not both.");
        const start = messageId
          ? { messageId }
          : resource && name
            ? { resourceId: (await resolveResource(toolContext, projectIdValue, resource)).id, name, ...(args.step === undefined ? {} : { step: numberArg(args, "step") }) }
            : (() => { throw invalid("Provide messageId or both resource and name."); })();
        const result = traceArchitectureQuery(indexed.index, start, {
          direction: args.direction as "upstream" | "downstream" | "both" | undefined,
          maxDepth: numberArg(args, "maxDepth"),
          maxNodes: numberArg(args, "maxNodes"),
          includeCandidates: typeof args.includeCandidates === "boolean" ? args.includeCandidates : undefined,
          includeRecovery: typeof args.includeRecovery === "boolean" ? args.includeRecovery : undefined,
        });
        return { text: JSON.stringify(result), structured: { ...result } };
      },
    },
    {
      name: "list_semantic_occurrences",
      title: "List semantic message occurrences",
       description: "List structured Sequence occurrences and Event Flow message entities, including authoritative bindings, plus conservative legacy message-like leads. Candidate leads are evidence for inspection only, never identity.",
       inputSchema: { projectId: projectId(), contextId: z.string().uuid().optional() },
      annotations: { ...READ_ONLY, title: "List semantic message occurrences" },
      requiredPermissions: ["project:search"],
      async run(args, toolContext) {
         const projectIdValue = stringArg(args, "projectId");
         const contextId = typeof args.contextId === "string" ? args.contextId : null;
         const indexed = await semanticIndex(toolContext, projectIdValue, contextId);
         const legacyCandidates = await legacySemanticCandidates(toolContext, projectIdValue, indexed.resources, contextId);
        const { index } = indexed;
        const occurrences = index.semanticOccurrences ?? [];
        const eventFlowMessages = index.eventFlowMessages ?? [];
        return { text: JSON.stringify({ occurrences, eventFlowMessages, legacyCandidates }), structured: { occurrences, eventFlowMessages, legacyCandidates } };
      },
    },
    {
      name: "find_semantic_message_candidates",
      title: "Find semantic message candidates",
      description: "Find normalized exact-name candidate matches across Sequence and Event Flow resources without mutating bindings or treating candidates as authoritative.",
       inputSchema: { projectId: projectId(), contextId: z.string().uuid().optional() },
      annotations: { ...READ_ONLY, title: "Find semantic message candidates" },
      requiredPermissions: ["project:search"],
      async run(args, toolContext) {
         const contextId = typeof args.contextId === "string" ? args.contextId : null;
         const candidates = semanticMessageCandidates((await semanticIndex(toolContext, stringArg(args, "projectId"), contextId)).index);
        return { text: JSON.stringify(candidates), structured: { candidates } };
      },
    },
    {
      name: "create_semantic_message",
      title: "Create semantic message identity",
       description: "Create an event or command identity in the caller's owned MY WORK context. contextId is required; this modifies MY WORK only, never SHARED. Authoritative publication requires an Architectural Proposal and promotion. The server generates the id and never infers bindings.",
         inputSchema: { projectId: projectId(), contextId: z.string().uuid(), name: z.string().min(1), kind: z.enum(["event", "command"]) },
      annotations: { ...WRITE, title: "Create semantic message identity" },
      requiredPermissions: ["project:update"],
      async run(args, toolContext) {
        const id = stringArg(args, "projectId");
         const result = await toolContext.catalog.createSemanticMessage(toolContext.context, id, { name: stringArg(args, "name"), kind: args.kind as "event" | "command" }, typeof args.contextId === "string" ? args.contextId : null);
        return { text: `Created semantic message ${result.message.id}.`, structured: result };
      },
    },
    {
      name: "delete_semantic_message",
      title: "Delete semantic message identity",
      description: "Delete an explicit identity only when no Sequence or Event Flow source still references it; this never silently destroys traceability.",
       inputSchema: { projectId: projectId(), contextId: z.string().uuid(), messageId: z.string().min(1), expectedManifestRevision: z.number().int().min(0).optional() },
      annotations: { ...DELETE, title: "Delete semantic message identity" },
      requiredPermissions: ["project:update"],
      async run(args, toolContext) {
        const id = stringArg(args, "projectId");
        const messageId = stringArg(args, "messageId");
         const contextId = stringArg(args, "contextId");
         const { index } = await semanticIndex(toolContext, id, contextId);
        const trace = traceSemanticMessage(index, messageId);
        if (!trace.identity) throw notFound(`No semantic message "${messageId}" exists.`);
        if (trace.occurrences.length || trace.eventFlowEntities.length) throw invalid(`Semantic message "${messageId}" is still referenced.`);
         const messages = (await toolContext.catalog.listSemanticMessages(toolContext.context, id, contextId)).filter((entry) => entry.id !== messageId);
         const result = await toolContext.catalog.updatePrivateSemanticMessages(toolContext.context, id, contextId, messages);
         return { text: `Deleted semantic message ${messageId}.`, structured: { messageId, messages: result } };
      },
    },
    {
      name: "update_semantic_message",
      title: "Rename semantic message identity",
       description: "Rename a semantic identity in the caller's owned MY WORK context. contextId is required; this modifies MY WORK only, never SHARED. Authoritative changes require an Architectural Proposal and promotion.",
       inputSchema: { projectId: projectId(), contextId: z.string().uuid(), messageId: z.string().min(1), name: z.string().min(1), expectedManifestRevision: z.number().int().min(0).optional() },
      annotations: { ...WRITE, title: "Rename semantic message identity" },
      requiredPermissions: ["project:update"],
      async run(args, toolContext) {
        const id = stringArg(args, "projectId");
        const messageId = stringArg(args, "messageId");
         const contextId = stringArg(args, "contextId");
         const messages = await toolContext.catalog.listSemanticMessages(toolContext.context, id, contextId);
        const existing = messages.find((entry) => entry.id === messageId);
        if (!existing) throw notFound(`No semantic message "${messageId}" exists.`);
        const next = messages.map((entry) => entry.id === messageId ? { ...entry, name: stringArg(args, "name") } : entry);
         const result = await toolContext.catalog.updatePrivateSemanticMessages(toolContext.context, id, contextId, next);
         return { text: `Renamed semantic message ${messageId}.`, structured: { message: next.find((entry) => entry.id === messageId), messages: result } };
      },
    },
    {
      name: "bind_semantic_message",
      title: "Bind semantic message occurrence",
       description: "Bind one exact occurrence in the caller's owned MY WORK context. contextId is required; this modifies MY WORK only, never SHARED, through the normal resource revision path. Authoritative publication requires an Architectural Proposal and promotion.",
       inputSchema: { projectId: projectId(), contextId: z.string().uuid(), resource: resourceReference(), messageId: z.string().min(1), name: z.string().min(1), step: z.number().int().min(1).optional(), expectedRevision: z.number().int().min(1) },
      annotations: { ...WRITE, title: "Bind semantic message occurrence" },
      requiredPermissions: ["resource:update"],
      async run(args, toolContext) {
        const id = stringArg(args, "projectId");
         const contextId = stringArg(args, "contextId");
         const identity = (await toolContext.catalog.listSemanticMessages(toolContext.context, id, contextId)).find((entry) => entry.id === stringArg(args, "messageId"));
        if (!identity) throw notFound(`No semantic message "${stringArg(args, "messageId")}" exists.`);
         const resource = await resolveResource(toolContext, id, stringArg(args, "resource"), contextId);
         const read = await toolContext.catalog.readResource(toolContext.context, id, resource.id, contextId);
        const next = bindSemanticReference(read.content, resource.type, stringArg(args, "name"), numberArg(args, "step"), identity.id, identity.kind);
         const updated = await toolContext.catalog.updateResource(toolContext.context, id, resource.id, { content: next, expectedRevision: numberArg(args, "expectedRevision")!, contextId });
        return { text: `Bound ${stringArg(args, "name")} to ${identity.id}.`, structured: { resource: updated, messageId: identity.id } };
      },
    },
    {
      name: "unbind_semantic_message",
      title: "Unbind semantic message occurrence",
       description: "Unbind one exact occurrence in the caller's owned MY WORK context. contextId is required; this modifies MY WORK only, never SHARED, through the normal resource revision path. Authoritative publication requires an Architectural Proposal and promotion.",
       inputSchema: { projectId: projectId(), contextId: z.string().uuid(), resource: resourceReference(), name: z.string().min(1), step: z.number().int().min(1).optional(), expectedRevision: z.number().int().min(1) },
      annotations: { ...WRITE, title: "Unbind semantic message occurrence" },
      requiredPermissions: ["resource:update"],
      async run(args, toolContext) {
        const id = stringArg(args, "projectId");
         const contextId = stringArg(args, "contextId");
         const resource = await resolveResource(toolContext, id, stringArg(args, "resource"), contextId);
         const read = await toolContext.catalog.readResource(toolContext.context, id, resource.id, contextId);
        const next = unbindSemanticReference(read.content, resource.type, stringArg(args, "name"), numberArg(args, "step"));
         const updated = await toolContext.catalog.updateResource(toolContext.context, id, resource.id, { content: next, expectedRevision: numberArg(args, "expectedRevision")!, contextId });
        return { text: `Unbound ${stringArg(args, "name")}.`, structured: { resource: updated } };
      },
    },
    {
      name: "get_event_catalog",
      title: "Get the event catalog",
      description:
        "List the events a project declares and, for each, the services that publish and subscribe to it. Paginated and bounded.",
      inputSchema: {
         projectId: projectId(),
         contextId: z.string().uuid().optional(),
         limit: limit(100, 500),
        cursor: cursor(),
      },
      annotations: { ...READ_ONLY, title: "Get the event catalog" },
      requiredPermissions: ["project:search"],
      async run(args, toolContext) {
        const id = stringArg(args, "projectId");
         const entries = await eventCatalog(toolContext, id, typeof args.contextId === "string" ? args.contextId : null);
        const { items, nextCursor } = page(
          entries,
          decodeCursor(
            typeof args.cursor === "string" ? args.cursor : undefined,
          ),
          numberArg(args, "limit") ?? 100,
        );
        return {
          text:
            items.length === 0
              ? "This project declares no events."
              : items
                  .map(
                    (entry) =>
                      `- ${entry.name} (declared in ${entry.declaredIn})`,
                  )
                  .join("\n"),
          structured: { events: items, nextCursor },
        };
      },
    },

    {
      name: "find_event_producers",
      title: "Find event producers",
      description:
        "Find the services that publish a given event, across the project's event flows.",
      inputSchema: {
         projectId: projectId(),
         contextId: z.string().uuid().optional(),
         event: z.string().min(1).describe("The event name to look for."),
      },
      annotations: { ...READ_ONLY, title: "Find event producers" },
      requiredPermissions: ["project:search"],
      async run(args, toolContext) {
        return findEventSides(
          toolContext,
          stringArg(args, "projectId"),
          stringArg(args, "event"),
           "producers",
          typeof args.contextId === "string" ? args.contextId : null,
        );
      },
    },

    {
      name: "find_event_consumers",
      title: "Find event consumers",
      description:
        "Find the services that subscribe to a given event, across the project's event flows.",
      inputSchema: {
         projectId: projectId(),
         contextId: z.string().uuid().optional(),
         event: z.string().min(1).describe("The event name to look for."),
      },
      annotations: { ...READ_ONLY, title: "Find event consumers" },
      requiredPermissions: ["project:search"],
      async run(args, toolContext) {
        return findEventSides(
          toolContext,
          stringArg(args, "projectId"),
          stringArg(args, "event"),
           "consumers",
          typeof args.contextId === "string" ? args.contextId : null,
        );
      },
    },
    {
      name: "find_retry_behavior",
      title: "Find failure and retry behavior",
      description: "Find documented failures and retries across a project's event flows. Filter by mechanism or return all evidence-backed semantics; unknown policy remains explicit.",
       inputSchema: { projectId: projectId(), contextId: z.string().uuid().optional(), mechanism: z.enum(["broker", "handler", "application", "scheduler", "external", "unknown"]).optional() },
      annotations: { ...READ_ONLY, title: "Find failure and retry behavior" },
      requiredPermissions: ["project:search"],
      async run(args, toolContext) {
         return findRetryBehavior(toolContext, stringArg(args, "projectId"), typeof args.mechanism === "string" ? args.mechanism : undefined, typeof args.contextId === "string" ? args.contextId : null);
      },
    },

    {
      name: "validate_project",
      title: "Validate a project",
      description:
        "Run the project's own validators across every SHARED resource, or across resources in an explicitly selected MY WORK context, and return diagnostics with severity, file and location. Bounded to the first 500 documents and a page of problems.",
      inputSchema: {
        projectId: projectId(),
        contextId: z.string().uuid().optional().describe("Include this owned MY WORK context in the effective project validation."),
        severity: z
          .enum(["error", "warning", "info"])
          .optional()
          .describe("Only return diagnostics of this severity."),
        limit: limit(100, 500),
        cursor: cursor(),
      },
      annotations: { ...READ_ONLY, title: "Validate a project" },
      requiredPermissions: ["project:validate"],
      async run(args, toolContext) {
        throwIfAborted(toolContext.signal);
        const id = stringArg(args, "projectId");
        const contextId = typeof args.contextId === "string" ? args.contextId : null;
        const { index } = await semanticIndex(toolContext, id, contextId);
        const wanted = args.severity;
        const filtered =
          typeof wanted === "string"
            ? index.diagnostics.filter(
                (diagnostic) => diagnostic.severity === wanted,
              )
            : index.diagnostics;
        const { items, nextCursor } = page(
          filtered,
          decodeCursor(
            typeof args.cursor === "string" ? args.cursor : undefined,
          ),
          numberArg(args, "limit") ?? 100,
        );
        return {
          text:
            items.length === 0
              ? "No problems found."
              : items
                  .map(
                    (diagnostic) =>
                      `- [${diagnostic.severity}] ${diagnostic.message}`,
                  )
                  .join("\n"),
          structured: {
            projectId: id,
            total: filtered.length,
            diagnostics: items.map((diagnostic) => ({
              severity: diagnostic.severity,
              message: diagnostic.message,
              code: String(diagnostic.code),
            })),
            nextCursor,
          },
        };
      },
    },
  ];
}

// ---- Semantic helpers ------------------------------------------------------

/** One event and where it was declared. */
interface EventCatalogEntry {
  name: string;
  declaredIn: string;
}

/** Every event a project's event flows declare. */
async function eventCatalog(
  toolContext: ToolContext,
  projectIdValue: string,
  contextId: string | null = null,
): Promise<EventCatalogEntry[]> {
  const resources = await toolContext.catalog.listResources(
    toolContext.context,
    projectIdValue,
    contextId,
  );
  const entries: EventCatalogEntry[] = [];
  for (const resource of resources) {
    if (resource.type !== "event-flow") continue;
    throwIfAborted(toolContext.signal);
    const { content } = await toolContext.catalog.readResource(
      toolContext.context,
      projectIdValue,
      resource.id,
      contextId,
    );
    const { flow } = analyzeEventFlow(content);
    for (const event of eventsOf(flow)) {
      entries.push({ name: event.name, declaredIn: resource.path });
    }
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  return entries;
}

/** Find the services that publish or consume an event. */
async function findEventSides(
  toolContext: ToolContext,
  projectIdValue: string,
  eventName: string,
  side: "producers" | "consumers",
  contextId: string | null = null,
): Promise<ToolOutcome> {
  const resources = await toolContext.catalog.listResources(toolContext.context, projectIdValue, contextId);
  const hits: Array<{ service: string; resource: string }> = [];
  for (const resource of resources) {
    if (resource.type !== "event-flow") continue;
    throwIfAborted(toolContext.signal);
    const { content } = await toolContext.catalog.readResource(
      toolContext.context,
      projectIdValue,
      resource.id,
      contextId,
    );
    const { flow } = analyzeEventFlow(content);
    const edges =
      side === "producers"
        ? publicationsOf(flow).filter((edge) => edge.event === eventName)
        : subscriptionsOf(flow).filter((edge) => edge.event === eventName);
    for (const edge of edges) {
      const service =
        "service" in edge && typeof edge.service === "string"
          ? edge.service
          : "(unknown)";
      hits.push({ service, resource: resource.path });
    }
  }
  return {
    text:
      hits.length === 0
        ? `No ${side} found for "${eventName}".`
        : hits.map((hit) => `- ${hit.service} (${hit.resource})`).join("\n"),
    structured: { event: eventName, [side]: hits },
  };
}

async function findRetryBehavior(toolContext: ToolContext, projectIdValue: string, mechanism?: string, contextId: string | null = null): Promise<ToolOutcome> {
  const resources = await toolContext.catalog.listResources(toolContext.context, projectIdValue, contextId);
  const hits: Array<{ resource: string; failures: unknown[]; retries: unknown[]; unknownPolicy: boolean }> = [];
  for (const resource of resources) {
    if (resource.type !== "event-flow") continue;
    const { content } = await toolContext.catalog.readResource(toolContext.context, projectIdValue, resource.id, contextId);
    const { flow } = analyzeEventFlow(content);
    const retries = (flow.causal?.retries ?? []).filter((retry) => mechanism === undefined || retry.mechanism === mechanism);
    const failures = flow.causal?.failures ?? [];
    if (retries.length || (mechanism === undefined && failures.length)) hits.push({ resource: resource.path, failures, retries, unknownPolicy: retries.some((retry) => !retry.mechanism || !retry.exhaustion) });
  }
  return { text: hits.length ? hits.map((hit) => `- ${hit.resource}: ${hit.retries.length} retries, ${hit.failures.length} failures${hit.unknownPolicy ? " (policy or exhaustion unknown)" : ""}`).join("\n") : "No documented failure or retry behavior found.", structured: { mechanism, flows: hits } };
}

/** Create or replace a document by path, with the revision contract enforced. */
async function upsertByPath(
  toolContext: ToolContext,
  input: {
    projectId: string;
    contextId?: string;
    path: string;
    type: ResourceRecord["type"];
    content: string;
    expectedRevision?: number;
    idempotencyKey?: string;
  },
): Promise<ToolOutcome> {
  const resources = await toolContext.catalog.listResources(
    toolContext.context,
    input.projectId,
    input.contextId ?? null,
  );
  const existing = resources.find((resource) => resource.path === input.path);
  if (existing === undefined) {
    const resource = await toolContext.catalog.createResource(
      toolContext.context,
      input.projectId,
      {
        path: input.path,
        type: input.type,
        content: input.content,
        ...(input.contextId === undefined ? {} : { contextId: input.contextId }),
        ...(input.idempotencyKey === undefined
          ? {}
          : { idempotencyKey: input.idempotencyKey }),
      },
    );
    return {
      text: `Created ${resource.path} at revision ${resource.revision}.`,
      structured: { created: true, resource },
    };
  }
  if (input.expectedRevision === undefined) {
    throw invalid(
      `"${input.path}" already exists at revision ${existing.revision}. Read it, then call again with expectedRevision: ${existing.revision}.`,
      { currentRevision: existing.revision, path: input.path },
    );
  }
  const resource = await toolContext.catalog.updateResource(
    toolContext.context,
    input.projectId,
    existing.id,
    {
      content: input.content,
      ...(input.contextId === undefined ? {} : { contextId: input.contextId }),
      expectedRevision: input.expectedRevision,
      ...(input.idempotencyKey === undefined
        ? {}
        : { idempotencyKey: input.idempotencyKey }),
    },
  );
  return {
    text: `Replaced ${resource.path}; it is now at revision ${resource.revision}.`,
    structured: { created: false, resource },
  };
}

/** Re-exported so the server can name the type it builds. */
export type { ResourceRecord };
