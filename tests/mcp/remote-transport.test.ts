/**
 * The remote MCP service, driven by the official MCP client SDK (Phase 6 §62).
 *
 * Every assertion here goes through a real socket with real Streamable HTTP: an
 * `initialize` handshake, `tools/list`, `tools/call`, `resources/list` and
 * `resources/read`. That is deliberate — the mission asks for an integration
 * client rather than hand-built HTTP calls, because a hand-built call proves the
 * test understands the transport, not that the server does.
 */
// @vitest-environment node
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { MCP_INSTRUCTIONS } from "../../apps/mcp/mcp/server";
import { ARTIFACT_GUIDANCE_URI, GOVERNANCE_GUIDE_URI, SEMANTIC_BINDING_URI } from "../../apps/mcp/mcp/reference";
import { createMcpTools } from "../../apps/mcp/mcp/tools";
import { analyzeResource } from "../../src/domain/project/resource-analysis";
import { parseDatabase } from "../../src/language/database/analyze";
import { projectDatabase } from "../../src/domain/database/visual-projection";
import { layoutGeometry } from "../../src/layout/elk-geometry-adapter";
import { createDiscoverSemanticCandidatesUseCase } from "../../src/application/discover-semantic-candidates";
import { ALL_PERMISSIONS } from "../../src/domain/access/permissions";
import { startHarness, type McpHarness } from "./harness";

let harness: McpHarness;
let ownerId: string;
let projectId: string;
let contextId: string;
let token: string;
let discoveryProjectToDelete: string | undefined;

beforeAll(async () => {
  harness = await startHarness();
  ownerId = await harness.aUser();
  projectId = await harness.aProject(ownerId);
  contextId = await harness.aPrivateWork(projectId, ownerId);
  token = (await harness.aToken(ownerId, [
    "project:read",
    "project:search",
    "project:validate",
    "project:update",
    "resource:read",
    "resource:write",
    "diagram:render",
  ])).token;
});

afterAll(async () => {
  await harness.close();
});

afterEach(async () => {
  if (discoveryProjectToDelete !== undefined) {
    await harness.service.runtime.projects.delete(discoveryProjectToDelete);
    discoveryProjectToDelete = undefined;
  }
});

/** Connect a client with a bearer token. */
async function connect(bearer: string | null, selectedContextId = contextId): Promise<Client> {
  const client = new Client({ name: "sdm-test", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(harness.url), {
      requestInit: {
        headers: bearer === null ? {} : { Authorization: `Bearer ${bearer}` },
      },
    }),
  );
  const callTool = client.callTool.bind(client);
  client.callTool = ((params: { name: string; arguments?: Record<string, unknown> }) =>
    callTool({
      ...params,
      ...(privateTools.has(params.name)
         ? { arguments: { ...(params.arguments ?? {}), contextId: selectedContextId } }
        : {}),
    })) as typeof client.callTool;
  return client;
}

const privateTools = new Set(["upsert_event_flow", "upsert_sequence_diagram", "upsert_documentation", "create_resource", "update_resource", "move_resource", "delete_resource", "create_resource_relationship", "create_semantic_message", "update_semantic_message", "delete_semantic_message", "bind_semantic_message", "unbind_semantic_message", "list_resources", "get_resource", "read_resource", "list_resource_relationships", "list_semantic_messages", "get_semantic_message", "find_semantic_message_candidates", "find_retry_behavior", "validate_project", "search_project"]);

/** The structured content of a successful tool call. */
function structured(result: unknown): Record<string, any> {
  return (
    (result as { structuredContent?: Record<string, any> }).structuredContent ??
    {}
  );
}

/** Models clients that expose MCP text blocks but hide structuredContent. */
function textualResult(result: unknown): Record<string, any> {
  const content = (result as { content: Array<{ type: string; text?: string }> }).content;
  const text = content.find(block => block.type === "text")?.text;
  if (text === undefined) throw new Error("MCP result has no text content");
  return JSON.parse(text);
}

describe("the remote MCP service over Streamable HTTP", () => {
  it("keeps initialize guidance aligned with exposed tool names", () => {
    const tools = new Set(createMcpTools().map((tool) => tool.name));
    const numberedTools = [
      ...MCP_INSTRUCTIONS.matchAll(/^\d+\.\s+([a-z_]+)/gm),
    ].map((match) => match[1]);
    expect(numberedTools.length).toBeGreaterThan(0);
    expect(numberedTools.filter((name) => !tools.has(name))).toEqual([]);
  });

  it("guides agents to the existing metadata discovery operations", () => {
    expect(MCP_INSTRUCTIONS).toContain("get_resource_metadata");
    expect(MCP_INSTRUCTIONS).toContain("search_project");
    expect(MCP_INSTRUCTIONS).toContain("semantic metadata");
    expect(MCP_INSTRUCTIONS).toContain("descriptions and tags");
    expect(MCP_INSTRUCTIONS).toContain("pass the owned MY WORK contextId to validate resources");
  });

  it("exposes canonical Sequence messaging guidance", async () => {
    const client = await connect(token);
    expect(client.getInstructions()).toContain(
      "semantic event publish BulkUpdateCardSuccessEvent messageRef <event-identity-id>",
    );
    const listed = await client.listResources();
    const reference = listed.resources.find((entry) =>
      entry.uri.endsWith("/reference/sequence-dsl"),
    );
    expect(reference).toBeDefined();
    const read = await client.readResource({ uri: reference!.uri });
    const guidance = (read.contents[0] as { text: string }).text;
    expect(guidance).toContain(
      "semantic event consume BulkUpdateCardSuccessEvent messageRef <event-identity-id>",
    );
    expect(guidance).toContain(
      "semantic command dispatch BulkUpdateCardsCommand messageRef <command-identity-id>",
    );
    expect(guidance).toContain("Sharing a `messageRef` correlates semantic messages");
    await client.close();
  });

  it("lets a governed agent discover and read the canonical governance skill", async () => {
    const client = await connect(token);
    expect(client.getServerCapabilities()?.resources).toBeDefined();
    const listed = await client.listResources();
    const governance = listed.resources.find(
      (entry) => entry.uri === GOVERNANCE_GUIDE_URI,
    );
    expect(governance).toMatchObject({
      uri: GOVERNANCE_GUIDE_URI,
      mimeType: "text/markdown",
    });
    const read = await client.readResource({ uri: GOVERNANCE_GUIDE_URI });
    const content = (read.contents[0] as { text: string }).text;
    expect(content).toBe(
      await readFile(
        new URL("../../docs/skills/mcp-governance.md", import.meta.url),
        "utf8",
      ),
    );
    expect(content).toContain("SHARED** is authoritative project knowledge");
    await client.close();
  });

  it("lets an external agent discover artifact purpose, examples, editing rules, and capabilities", async () => {
    const client = await connect(token);
    expect(client.getInstructions()).toContain(ARTIFACT_GUIDANCE_URI);
    const listed = await client.listResources();
    const reference = listed.resources.find((entry) => entry.uri === ARTIFACT_GUIDANCE_URI);
    expect(reference).toMatchObject({ uri: ARTIFACT_GUIDANCE_URI, mimeType: "text/markdown" });
    const read = await client.readResource({ uri: ARTIFACT_GUIDANCE_URI });
    const content = (read.contents[0] as { text: string }).text;
    for (const phrase of [
      "A Conceptual Diagram documents important concepts",
      'relation associated customer -- account "associated with"',
      "Preserve an ID when the same concept is renamed",
      "A Database Diagram documents persistent data structure",
      "foreign-key orders_customer orders (customer_id) -> customers (id)",
      "identity remains exact-name based",
      "Product visual rendering",
      "Presentation rendering",
    ]) expect(content).toContain(phrase);
    await client.close();
  });

  it("returns a not-found protocol error for an unknown remote resource", async () => {
    const client = await connect(token);
    let error: unknown;
    try {
      await client.readResource({ uri: "seqdocs://reference/unknown" });
    } catch (caught) {
      error = caught;
    }
    expect(String(error)).toMatch(/MCP error -32602/i);
    expect(String(error)).toMatch(/not found/i);
    await client.close();
  });

  it("negotiates a protocol version the SDK implements", async () => {
    const client = await connect(token);
    const version = client.getServerVersion();
    expect(version?.name).toBe("sequencediagrams-mcp");
    expect(client.getInstructions()).toContain("list_projects");
    await client.close();
  });

  it("advertises the semantic and primitive tools", async () => {
    const client = await connect(token);
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);
    expect(names).toContain("list_projects");
    expect(names).toContain("read_resource");
    expect(names).toContain("update_resource");
    expect(names).toContain("upsert_sequence_diagram");
    expect(names).toContain("validate_project");
    expect(names).toContain("search_project");
    expect(names).toContain("list_resource_relationships");
    expect(names).toContain("create_resource_relationship");
    expect(names).toContain("find_retry_behavior");
    expect(names).toContain("get_project_capabilities");
    // A write tool must not claim to be read-only.
    const update = tools.find((tool) => tool.name === "update_resource");
    expect(update?.annotations?.readOnlyHint).toBe(false);
    const read = tools.find((tool) => tool.name === "read_resource");
    expect(read?.annotations?.readOnlyHint).toBe(true);
    await client.close();
  });

  it("exposes shared capability decisions without making them authorization", async () => {
    const client = await connect(token);
    const result = await client.callTool({
      name: "get_project_capabilities",
      arguments: { projectId, contextId },
    });
    expect(result.isError).toBeFalsy();
    expect(structured(result).project["shared.read"]).toMatchObject({
      capability: "shared.read",
      allowed: true,
    });
    expect(structured(result).target.kind).toBe("private-work");
    expect(client.getInstructions()).toContain("Capability results are advisory");
    await client.close();
  });

  it("describes the private publication boundary on mutation tools", async () => {
    const client = await connect(token);
    const { tools } = await client.listTools();
    for (const name of ["create_resource", "update_resource", "move_resource", "delete_resource", "create_resource_relationship", "create_semantic_message"]) {
      const description = tools.find((tool) => tool.name === name)?.description ?? "";
      expect(description).toContain("MY WORK");
      expect(description).toContain("never SHARED");
      expect(description).toContain("Architectural Proposal");
    }
    await client.close();
  });

  it("lets an external client discover and author causal Event Flow syntax", async () => {
    const client = await connect(token);
    expect(client.getInstructions()).toContain("supported source artifacts");
    expect(client.getInstructions()).toContain(
      "genuinely useful cross-cutting Notes",
    );
    expect(client.getInstructions()).toContain(
      "orthogonal projections, not mutually exclusive classifications",
    );
    expect(client.getInstructions()).toContain(
      "Do not mechanically duplicate every Sequence",
    );
    const listed = await client.listResources();
    const reference = listed.resources.find((entry) =>
      entry.uri.endsWith("/reference/event-flow-dsl"),
    );
    expect(reference).toBeDefined();
    const referenceRead = await client.readResource({ uri: reference!.uri });
    const guidance = (referenceRead.contents[0] as { text: string }).text;
    for (const phrase of [
      "handler <id>",
      "handled by",
      "causes",
      "effect <id>",
      "provenance: external|internal|unknown",
      "failure <id>",
      "retry <id>",
    ]) {
      expect(guidance).toContain(phrase);
    }

    const created = await client.callTool({
      name: "upsert_event_flow",
      arguments: {
        projectId,
        path: "causal.eventseq",
        content: [
          "title Minimal causal flow",
          "event Input {",
          "  provenance: external",
          "}",
          "event Output",
          "handler HandleInput",
          "Input handled by HandleInput",
          "effect persist-input on HandleInput kind state-update: Persist input",
          "HandleInput causes Output",
        ].join("\n"),
      },
    });
    expect(created.isError, JSON.stringify(created)).toBeFalsy();

    const retryFlow = await client.callTool({
      name: "upsert_event_flow",
      arguments: {
        projectId,
        path: "retry.eventseq",
        content: [
          "event Input",
          "handler HandleInput",
          "failure processing-failed on handler HandleInput {",
          "  classification: processing",
          "}",
          "retry processing-retry for processing-failed {",
          "  mechanism: handler",
          "  target: same-execution",
          "}",
        ].join("\n"),
      },
    });
    expect(retryFlow.isError).toBeFalsy();
    const discovered = await client.callTool({ name: "find_retry_behavior", arguments: { projectId } });
    expect(structured(discovered).flows).toEqual(expect.arrayContaining([expect.objectContaining({ resource: "retry.eventseq" })]));

    const invalid = await client.callTool({
      name: "upsert_event_flow",
      arguments: {
        projectId,
        path: "invalid-causal.eventseq",
        content: "event Input\nInput handled by MissingHandler",
      },
    });
    expect(invalid.isError).toBe(true);
    expect(structured(invalid).error.details.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "eventflow.unknown-handler" }),
      ]),
    );
    await client.close();
  });

  it("dogfoods exact bindable anchors and evidence-backed binding over MCP", async () => {
    const client = await connect(token);
    const { tools } = await client.listTools();
    const createSchema = tools.find(tool => tool.name === "create_semantic_binding")!.inputSchema as any;
    const updateSchema = tools.find(tool => tool.name === "update_semantic_binding")!.inputSchema as any;
    expect(createSchema.properties).toMatchObject({ projectId: expect.any(Object), contextId: expect.any(Object), binding: expect.any(Object) });
    expect(createSchema.required).toEqual(expect.arrayContaining(["projectId", "contextId", "binding"]));
    expect(createSchema.properties.binding.required).toEqual(expect.arrayContaining(["id", "left", "right", "relation", "evidence"]));
    expect(createSchema.properties.binding.properties.left.required).toEqual(expect.arrayContaining(["version", "resourceId", "representation", "entityKind", "identity"]));
    expect(createSchema.properties.binding.properties.relation.enum).toEqual(["represents-in"]);
    expect(updateSchema.required).toEqual(expect.arrayContaining(["contextId", "binding", "expectedRevision"]));

    const conceptual = await client.callTool({ name: "create_resource", arguments: {
      projectId, path: "billing/concepts.concept", type: "conceptual",
      content: 'concept recharge-registry "recharge-registry"',
    } });
    const database = await client.callTool({ name: "create_resource", arguments: {
      projectId, path: "billing/recharges.dbschema", type: "database",
      content: 'table programmed_recharges_events - "programmed_recharges_events"',
    } });
    expect(conceptual.isError, JSON.stringify(conceptual)).toBeFalsy();
    expect(database.isError, JSON.stringify(database)).toBeFalsy();

    const listed = await client.callTool({ name: "get_project_index", arguments: { projectId, contextId } });
    const clientVisible = textualResult(listed);
    expect(clientVisible).toEqual(structured(listed));
    const entities = clientVisible.entities as Array<Record<string, any>>;
    const concept = entities.find(entity => entity.displayName === "recharge-registry")!;
    const table = entities.find(entity => entity.displayName === "programmed_recharges_events")!;
    expect(concept).toMatchObject({ resourceId: structured(conceptual).resource.id, representation: "conceptual", entityKind: "concept", resolution: "resolved", contextId });
    expect(table).toMatchObject({ resourceId: structured(database).resource.id, representation: "database", entityKind: "table", resolution: "resolved", contextId });
    expect(concept.anchor).toEqual({ version: 1, resourceId: concept.resourceId, representation: concept.representation, entityKind: concept.entityKind, identity: concept.identity });

    const sharedOnly = await client.callTool({ name: "get_project_index", arguments: { projectId } });
    expect(textualResult(sharedOnly)).toEqual(structured(sharedOnly));
    expect(textualResult(sharedOnly).entities).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ resourceId: structured(conceptual).resource.id }),
      expect.objectContaining({ resourceId: structured(database).resource.id }),
    ]));

    const created = await client.callTool({ name: "create_semantic_binding", arguments: {
      projectId,
      contextId,
      binding: {
        id: "f4c6d93e-f19c-4f72-a9bc-2966fc9cb5ea", left: concept.anchor, right: table.anchor,
        relation: "represents-in",
        evidence: { version: 1, rationale: "BillingMiddleware maps recharge registry events to this persisted table.", items: [{ kind: "external", reference: "src/billing/BillingMiddleware.ts; migrations/2026_programmed_recharges_events.sql", description: "The ORM mapping and migration establish the persisted event table." }] },
      },
    } });
    expect(created.isError, JSON.stringify(created)).toBeFalsy();
    const byConcept = await client.callTool({ name: "get_semantic_bindings_for_entity", arguments: { projectId, contextId, anchor: concept.anchor } });
    expect(structured(byConcept).bindings).toEqual([expect.objectContaining({ binding: expect.objectContaining({ id: "f4c6d93e-f19c-4f72-a9bc-2966fc9cb5ea", left: concept.anchor, right: table.anchor, relation: "represents-in" }), resolution: { left: "resolved", right: "resolved" } })]);
    const bindingPage = await client.callTool({ name: "list_semantic_bindings", arguments: { projectId, contextId, resourceId: structured(conceptual).resource.id, anchor: concept.anchor, limit: 1 } });
    expect(bindingPage.isError).toBe(false);
    expect(textualResult(bindingPage)).toEqual(structured(bindingPage));
    expect(structured(bindingPage).bindings).toEqual([expect.objectContaining({ id: "f4c6d93e-f19c-4f72-a9bc-2966fc9cb5ea", left: concept.anchor, right: table.anchor, revision: 1, evidence: expect.any(Object), resolution: { left: "resolved", right: "resolved" }, provenance: { context: "MY_WORK", contextId } })]);

    const listedResources = await client.listResources();
    const reference = listedResources.resources.find(entry => entry.uri === SEMANTIC_BINDING_URI);
    expect(reference).toBeDefined();
    const referenceText = (await client.readResource({ uri: reference!.uri })).contents[0] as { text: string };
    expect(referenceText.text.toLowerCase()).toContain("copy the returned");
    expect(referenceText.text).toContain("never evidence");

    const bindingValue = structured(created).binding as Record<string, any>;
    const createBinding = { id: bindingValue.id, left: bindingValue.left, right: bindingValue.right, relation: bindingValue.relation, evidence: bindingValue.evidence };
    const invalidPayloads = [
      { ...createBinding, left: undefined },
      { ...createBinding, right: undefined },
      { ...createBinding, left: { ...concept.anchor, resourceId: undefined } },
      { ...createBinding, left: { ...concept.anchor, representation: "sequence" } },
      { ...createBinding, left: { ...concept.anchor, entityKind: "table" } },
      { ...createBinding, left: { ...concept.anchor, identity: { kind: "local-id", value: "not-indexed" } } },
      { ...createBinding, relation: "related-to" },
      { ...createBinding, evidence: { version: 1, rationale: "", items: [] } },
    ];
    for (const [index, invalidBinding] of invalidPayloads.entries()) {
      const invalidPayload = await client.callTool({ name: "create_semantic_binding", arguments: { projectId, contextId, binding: { ...invalidBinding, id: `a84e63a0-45df-4d51-ae4b-51f073e2e2${String(index).padStart(2, "0")}` } } });
      expect(invalidPayload.isError).toBe(true);
      expect(JSON.stringify(invalidPayload)).toMatch(/validation|invalid|left|right|resourceId|representation|entityKind|relation|evidence/i);
      expect(JSON.stringify(invalidPayload)).not.toMatch(/Cannot read properties|internal TypeError/i);
    }

    const otherOwner = await harness.aUser("Other binding owner");
    const otherContext = await harness.aPrivateWork(projectId, otherOwner);
    const foreignIndex = await client.callTool({ name: "get_project_index", arguments: { projectId, contextId: otherContext } });
    expect(foreignIndex.isError).toBe(true);
    expect(JSON.stringify(foreignIndex)).toMatch(/forbidden|private|owned|context/i);
    const wrongContext = await client.callTool({ name: "create_semantic_binding", arguments: { projectId, contextId: otherContext, binding: createBinding } });
    expect(wrongContext.isError).toBe(true);
    expect(JSON.stringify(wrongContext)).toMatch(/forbidden|private|owned|context/i);

    const updated = { ...createBinding, revision: bindingValue.revision, status: bindingValue.status, provenance: bindingValue.provenance, evidence: { ...bindingValue.evidence, rationale: "Clarified ORM and migration evidence." } };
    const firstUpdate = await client.callTool({ name: "update_semantic_binding", arguments: { projectId, contextId, binding: updated, expectedRevision: 1 } });
    expect(firstUpdate.isError, JSON.stringify(firstUpdate)).toBeFalsy();
    const stale = await client.callTool({ name: "update_semantic_binding", arguments: { projectId, contextId, binding: updated, expectedRevision: 1 } });
    expect(stale.isError).toBe(true);
    expect(structured(stale).error.code).toBe("conflict");
    await client.close();
  });

  it("discovers read-only candidates from SHARED and owned effective knowledge for text-only clients", async () => {
    const client = await connect(token);
    const discoveryProjectId = await harness.aProject(ownerId, "Candidate discovery MCP");
    discoveryProjectToDelete = discoveryProjectId;
    const workId = await harness.aPrivateWork(discoveryProjectId, ownerId);
    const addResource = async (privateContextId: string | null, path: string, type: "conceptual" | "database", content: string) => {
      await harness.service.runtime.projects.createResource(discoveryProjectId, {
        path,
        type,
        ...(privateContextId === null ? {} : { contextId: privateContextId }),
      });
      await harness.service.runtime.storageForContext(discoveryProjectId, privateContextId).write(path, content);
    };
    await addResource(null, "shared.concept", "conceptual", 'concept account "Account"');
    await addResource(null, "shared.dbschema", "database", 'table account - "Account"');
    await addResource(workId, "private.concept", "conceptual", 'concept ledger "Ledger"');
    await addResource(workId, "private.dbschema", "database", 'table ledger - "Ledger"');
    const resourcesBefore = await harness.service.runtime.projects.listResources(discoveryProjectId, null);
    const bindingsBefore = await harness.service.runtime.semanticBindings.list({ projectId: discoveryProjectId, contextId: null });

    const shared = await client.callTool({ name: "discover_semantic_candidates", arguments: { projectId: discoveryProjectId } });
    expect(shared.isError).toBe(false);
    expect(structured(shared).status).toBe("unconfirmed");
    expect(textualResult(shared)).toEqual(structured(shared));
    expect(textualResult(shared).notice).toContain("not bindings or evidence");
    expect(structured(shared).total).toBe(1);
    expect(structured(shared).candidates[0]).toMatchObject({ leftPath: "shared.concept", rightPath: "shared.dbschema" });

    const entityPage = await client.callTool({ name: "list_semantic_entities", arguments: { projectId: discoveryProjectId, representation: "conceptual", limit: 1 } });
    expect(entityPage.isError).toBe(false);
    expect(textualResult(entityPage)).toEqual(structured(entityPage));
    expect(structured(entityPage).entities[0]).toMatchObject({ displayName: "Account", anchor: { resourceId: expect.any(String), representation: "conceptual", identity: { kind: "local-id", value: "account" } } });
    expect(structured(entityPage).nextCursor).toBeNull();

    const diagnosis = await client.callTool({ name: "diagnose_semantic_discovery", arguments: { projectId: discoveryProjectId } });
    expect(diagnosis.isError).toBe(false);
    expect(textualResult(diagnosis)).toEqual(structured(diagnosis));
    expect(structured(diagnosis)).toMatchObject({ diagnosis: "CANDIDATES_DISCOVERED", compatibleExactNamePairs: 1, discoveredCandidates: 1 });

    const databaseEntities = await client.callTool({ name: "list_semantic_entities", arguments: { projectId: discoveryProjectId, representation: "database", resourceId: (await harness.service.runtime.projects.listResources(discoveryProjectId, null)).find((resource) => resource.path === "shared.dbschema")!.id } });
    expect(databaseEntities.isError).toBe(false);
    expect(textualResult(databaseEntities)).toEqual(structured(databaseEntities));
    expect(structured(databaseEntities).entities).toHaveLength(1);
    expect(structured(databaseEntities).entities[0]).toMatchObject({ displayName: "Account", anchor: { representation: "database", entityKind: "table", identity: { kind: "local-id", value: "account" } } });

    const first = await client.callTool({ name: "discover_semantic_candidates", arguments: { projectId: discoveryProjectId, contextId: workId, limit: 1 } });
    expect(first.isError).toBe(false);
    expect(textualResult(first)).toEqual(structured(first));
    expect(structured(first).total).toBe(2);
    expect(structured(first).nextCursor).toBeDefined();
    const commonResult = await createDiscoverSemanticCandidatesUseCase(harness.service.catalog)({
      requestId: "mcp-discovery-test",
      principal: { subjectUserId: ownerId, actor: { kind: "user", userId: ownerId }, authType: "session", scopes: [...ALL_PERMISSIONS] },
    }, { projectId: discoveryProjectId, contextId: workId, limit: 1 });
    expect(structured(first)).toEqual(commonResult);
    const second = await client.callTool({ name: "discover_semantic_candidates", arguments: { projectId: discoveryProjectId, contextId: workId, limit: 1, cursor: structured(first).nextCursor as string } });
    const paged = [...structured(first).candidates, ...structured(second).candidates] as Array<{ id: string }>;
    expect(new Set(paged.map(candidate => candidate.id)).size).toBe(2);
    expect(paged).toHaveLength(2);
    const selected = structured(first).candidates[0] as { id: string; fingerprint: string; left: unknown; right: unknown };
    const inspected = await client.callTool({ name: "get_semantic_candidate", arguments: { projectId: discoveryProjectId, contextId: workId, candidateId: selected.id } });
    expect(inspected.isError).toBe(false);
    expect(textualResult(inspected)).toEqual(structured(inspected));
    expect((inspected as { content: Array<{ text: string }> }).content[0]!.text).toContain("unconfirmed candidate suggestion");
    expect(structured(inspected).candidate).toMatchObject({ id: selected.id, fingerprint: selected.fingerprint, left: selected.left, right: selected.right });
    const assessed = await client.callTool({ name: "assess_semantic_candidate", arguments: { projectId: discoveryProjectId, contextId: workId, candidateId: selected.id, decision: "NEEDS_EVIDENCE", rationale: "Check migration evidence.", fingerprint: selected.fingerprint } });
    expect(assessed.isError).toBe(false);
    expect(textualResult(assessed)).toEqual(structured(assessed));
    expect(structured(assessed)).toMatchObject({ bindingCreated: false, assessment: { revision: 1, status: "CURRENT" } });
    const listed = await client.callTool({ name: "list_candidate_assessments", arguments: { projectId: discoveryProjectId, contextId: workId, status: "CURRENT" } });
    expect(listed.isError).toBe(false);
    expect(textualResult(listed)).toEqual(structured(listed));
    expect(structured(listed).assessments).toHaveLength(1);
    expect(await harness.service.runtime.semanticBindings.list({ projectId: discoveryProjectId, contextId: workId })).toEqual(bindingsBefore);
    expect(await harness.service.runtime.projects.listResources(discoveryProjectId, null)).toEqual(resourcesBefore);
    expect(await harness.service.runtime.semanticBindings.list({ projectId: discoveryProjectId, contextId: null })).toEqual(bindingsBefore);
    await client.close();
  });

  it("lets an external client create, bind, trace and validate semantic messages", async () => {
    const client = await connect(token);
    const sequence = await client.callTool({
      name: "upsert_sequence_diagram",
      arguments: {
        projectId,
        path: "semantic-trace.seq",
        content: [
          "participant Producer",
          "participant Consumer",
          "Producer ->> Consumer: Created",
          "semantic event publish Created",
          "Producer ->> Consumer: Created again",
          "semantic event consume Created",
        ].join("\n"),
      },
    });
    const flow = await client.callTool({
      name: "upsert_event_flow",
      arguments: {
        projectId,
        path: "semantic-trace.eventseq",
        content: "event Created\n\nevent Followup\nhandler CreatedHandler\nCreated handled by CreatedHandler\nCreatedHandler causes Followup\neffect persist-created on CreatedHandler kind state: Persist created\n",
      },
    });
    expect(sequence.isError).toBeFalsy();
    expect(flow.isError).toBeFalsy();

    const created = await client.callTool({
      name: "create_semantic_message",
      arguments: { projectId, name: "Created", kind: "event" },
    });
    expect(created.isError, JSON.stringify(created)).toBeFalsy();
    const createdMessageId = (structured(created).message as { id: string }).id;

    const sequenceResource = structured(sequence).resource as { id: string; revision: number };
    const flowResource = structured(flow).resource as { id: string; revision: number };
    const boundProducer = await client.callTool({
      name: "bind_semantic_message",
      arguments: { projectId, resource: sequenceResource.id, messageId: createdMessageId, name: "Created", step: 1, expectedRevision: sequenceResource.revision },
    });
    expect(boundProducer.isError).toBeFalsy();
    const boundConsumer = await client.callTool({
      name: "bind_semantic_message",
      arguments: { projectId, resource: sequenceResource.id, messageId: createdMessageId, name: "Created", step: 2, expectedRevision: structured(boundProducer).resource.revision },
    });
    expect(boundConsumer.isError).toBeFalsy();
    const boundFlow = await client.callTool({
      name: "bind_semantic_message",
      arguments: { projectId, resource: flowResource.id, messageId: createdMessageId, name: "Created", expectedRevision: flowResource.revision },
    });
    expect(boundFlow.isError).toBeFalsy();

    const listedMessages = await client.callTool({ name: "list_semantic_messages", arguments: { projectId } });
    expect(structured(listedMessages).messages).toEqual([
      { id: createdMessageId, name: "Created", kind: "event" },
    ]);
    const trace = await client.callTool({ name: "get_semantic_message", arguments: { projectId, messageId: createdMessageId } });
    expect(structured(trace).identity).toEqual(expect.objectContaining({ id: createdMessageId, kind: "event" }));
    expect(structured(trace).occurrences).toHaveLength(2);
    expect(structured(trace).eventFlowEntities).toHaveLength(1);
    expect(structured(trace).eventFlowEntities[0]).toEqual(expect.objectContaining({ messageRef: createdMessageId, name: "Created" }));
    expect(structured(trace).downstream).toEqual(expect.arrayContaining([expect.objectContaining({ handler: "CreatedHandler", messages: ["Followup"] })]));
    const candidates = await client.callTool({ name: "find_semantic_message_candidates", arguments: { projectId } });
    expect(structured(candidates).candidates).toEqual(expect.arrayContaining([expect.objectContaining({ name: "Created", authoritative: true })]));
    const validation = await client.callTool({ name: "validate_project", arguments: { projectId } });
    expect(validation.isError).toBeFalsy();
    expect(structured(validation).diagnostics).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "project.dangling-semantic-message-ref" }),
    ]));
    const refreshed = await connect(token);
    const persisted = await refreshed.callTool({ name: "list_semantic_messages", arguments: { projectId } });
    expect(structured(persisted).messages).toEqual([
      { id: createdMessageId, name: "Created", kind: "event" },
    ]);
    const persistedTrace = await refreshed.callTool({ name: "get_semantic_message", arguments: { projectId, messageId: createdMessageId } });
    expect(structured(persistedTrace).eventFlowEntities).toHaveLength(1);
    const persistedValidation = await refreshed.callTool({ name: "validate_project", arguments: { projectId } });
    expect(structured(persistedValidation).diagnostics).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "project.dangling-semantic-message-ref" }),
    ]));
    await refreshed.close();
    const protectedDelete = await client.callTool({ name: "delete_semantic_message", arguments: { projectId, messageId: createdMessageId, expectedManifestRevision: 1 } });
    expect(protectedDelete.isError).toBe(true);
    const resources = structured(await client.callTool({ name: "list_resources", arguments: { projectId } })).resources as Array<{ id: string; path: string; revision: number }>;
    const sequenceCurrent = resources.find((resource) => resource.path === "semantic-trace.seq")!;
    const flowCurrent = resources.find((resource) => resource.path === "semantic-trace.eventseq")!;
    const unboundProducer = await client.callTool({ name: "unbind_semantic_message", arguments: { projectId, resource: sequenceCurrent.id, name: "Created", step: 1, expectedRevision: sequenceCurrent.revision } });
    const unboundConsumer = await client.callTool({ name: "unbind_semantic_message", arguments: { projectId, resource: sequenceCurrent.id, name: "Created", step: 2, expectedRevision: structured(unboundProducer).resource.revision } });
    const unboundFlow = await client.callTool({ name: "unbind_semantic_message", arguments: { projectId, resource: flowCurrent.id, name: "Created", expectedRevision: flowCurrent.revision } });
    expect(unboundConsumer.isError).toBeFalsy();
    expect(unboundFlow.isError).toBeFalsy();
    const deleted = await client.callTool({ name: "delete_semantic_message", arguments: { projectId, messageId: createdMessageId, expectedManifestRevision: 1 } });
    expect(deleted.isError).toBeFalsy();
    await client.close();
  });

  it("binds private Sequence and Event Flow occurrences to a SHARED identity", async () => {
    const identity = { id: "a7d03b12-0004-4a11-8111-000000000004", name: "UpOneTransactionRaisedEvent", kind: "event" as const };
    const storage = harness.service.runtime.storageFor(projectId);
    const manifestFile = await storage.read("project.json");
    const manifest = manifestFile.ok && manifestFile.value ? JSON.parse(manifestFile.value.content) : {};
    await storage.write("project.json", JSON.stringify({ format: "sequencediagrams-project", version: 1, resources: [], ...manifest, semanticMessages: [identity] }));

    const client = await connect(token);
    const sequence = structured(await client.callTool({
      name: "upsert_sequence_diagram",
      arguments: { projectId, path: "upone-account-fanout.seq", content: "participant Producer\nparticipant Consumer\nProducer ->> Consumer: PriorEvent\nsemantic event publish PriorEvent\nProducer ->> Consumer: UpOneTransactionRaisedEvent\nsemantic event publish UpOneTransactionRaisedEvent" },
    }));
    const flow = structured(await client.callTool({
      name: "upsert_event_flow",
      arguments: { projectId, path: "shared-binding.eventseq", content: `event ${identity.name}\n` },
    }));
    const sequenceResource = sequence.resource as { id: string; revision: number };
    const flowResource = flow.resource as { id: string; revision: number };

    const boundSequence = await client.callTool({ name: "bind_semantic_message", arguments: { projectId, resource: sequenceResource.id, messageId: identity.id, name: identity.name, step: 2, expectedRevision: sequenceResource.revision } });
    expect(boundSequence.isError, JSON.stringify(boundSequence)).toBeFalsy();
    const boundFlow = await client.callTool({ name: "bind_semantic_message", arguments: { projectId, resource: flowResource.id, messageId: identity.id, name: identity.name, expectedRevision: flowResource.revision } });
    expect(boundFlow.isError, JSON.stringify(boundFlow)).toBeFalsy();

    const trace = await client.callTool({ name: "get_semantic_message", arguments: { projectId, messageId: identity.id } });
    expect(structured(trace).occurrences).toEqual(expect.arrayContaining([expect.objectContaining({ messageRef: identity.id })]));
    expect(structured(trace).eventFlowEntities).toEqual(expect.arrayContaining([expect.objectContaining({ messageRef: identity.id })]));
    const validation = structured(await client.callTool({ name: "validate_project", arguments: { projectId } }));
    expect(validation.diagnostics).not.toEqual(expect.arrayContaining([expect.objectContaining({ code: "project.dangling-semantic-message-ref" })]));
    expect(await harness.service.runtime.knowledgeContexts.listPrivateMessages(projectId, contextId)).toEqual([]);
    const unchangedManifest = await storage.read("project.json");
    expect(unchangedManifest.ok && unchangedManifest.value ? JSON.parse(unchangedManifest.value.content).semanticMessages : []).toEqual([identity]);
    await client.close();
  });

  it("resolves block-form Event Flow bindings through the remote trace", async () => {
    const client = await connect(token);
    const sequence = await client.callTool({
      name: "upsert_sequence_diagram",
      arguments: {
        projectId,
        path: "semantic-block-trace.seq",
        content: [
          "participant Producer",
          "participant Consumer",
          "Producer ->> Consumer: ExampleEvent",
          "semantic event publish ExampleEvent messageRef semantic-example",
        ].join("\n"),
      },
    });
    expect(sequence.isError).toBeFalsy();
    const flow = await client.callTool({
      name: "upsert_event_flow",
      arguments: {
        projectId,
        path: "semantic-block-trace.eventseq",
        content: [
          "event ExampleEvent { messageRef semantic-example",
          "}",
          "event SendEmailCommand { messageRef semantic-command",
          "  kind: command",
          "}",
        ].join("\n"),
      },
    });
    expect(flow.isError).toBeFalsy();

    const created = await client.callTool({
      name: "create_semantic_message",
      arguments: { projectId, id: "semantic-example", name: "ExampleEvent", kind: "event", expectedManifestRevision: 2 },
    });
    expect(created.isError, JSON.stringify(created)).toBeFalsy();
    const command = await client.callTool({
      name: "create_semantic_message",
      arguments: { projectId, id: "semantic-command", name: "SendEmailCommand", kind: "command", expectedManifestRevision: 3 },
    });
    expect(command.isError, JSON.stringify(command)).toBeFalsy();

    await client.close();
    const reloaded = await connect(token);
    const trace = await reloaded.callTool({ name: "get_semantic_message", arguments: { projectId, messageId: "semantic-example" } });
    expect(structured(trace).occurrences).toHaveLength(1);
    expect(structured(trace).eventFlowEntities).toEqual([
      expect.objectContaining({
        projectId,
        resourcePath: "semantic-block-trace.eventseq",
        nodeId: "event@0:0",
        kind: "event",
        messageRef: "semantic-example",
      }),
    ]);
    const commandTrace = await reloaded.callTool({ name: "get_semantic_message", arguments: { projectId, messageId: "semantic-command" } });
    expect(structured(commandTrace).eventFlowEntities).toEqual([
      expect.objectContaining({
        projectId,
        resourcePath: "semantic-block-trace.eventseq",
        nodeId: "event@2:0",
        kind: "command",
        messageRef: "semantic-command",
      }),
    ]);
    await reloaded.close();
  });

  it("lets an external client discover, create, validate and rediscover typed complementary views", async () => {
    const client = await connect(token);
    expect(client.getInstructions()).toContain(
      "Prose such as \"complements X\" in a description is not a replacement",
    );
    expect(client.getInstructions()).toContain(
      "complementary projections of substantially the same behavior",
    );

    const sequence = await client.callTool({
      name: "upsert_sequence_diagram",
      arguments: {
        projectId,
        path: "typed-complementary.seq",
        content: "title Typed complementary\n",
      },
    });
    const flow = await client.callTool({
      name: "upsert_event_flow",
      arguments: {
        projectId,
        path: "typed-complementary.eventseq",
        content: "title Typed causal\nevent Input\n",
      },
    });
    expect(sequence.isError).toBeFalsy();
    expect(flow.isError).toBeFalsy();

    const sequenceId = structured(sequence).resource.id;
    const flowId = structured(flow).resource.id;
    const before = await client.callTool({
      name: "list_resource_relationships",
      arguments: { projectId },
    });
    expect(structured(before).relationships).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sourceId: sequenceId, targetId: flowId }),
      ]),
    );

    const created = await client.callTool({
      name: "create_resource_relationship",
      arguments: {
        projectId,
        source: sequenceId,
        target: flowId,
        sourceRole: "execution",
        targetRole: "causal",
      },
    });
    expect(created.isError).toBeFalsy();
    expect(structured(created).relationship).toEqual(
      expect.objectContaining({
        kind: "complementary-view",
        sourceId: expect.any(String),
        targetId: expect.any(String),
        sourceRole: "execution",
        targetRole: "causal",
      }),
    );

    const after = await client.callTool({
      name: "list_resource_relationships",
      arguments: { projectId },
    });
    expect(structured(after).relationships).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "complementary-view",
          sourceId: sequenceId,
          targetId: flowId,
          sourceRole: "execution",
          targetRole: "causal",
        }),
      ]),
    );
    const listed = await client.callTool({
      name: "list_resources",
      arguments: { projectId },
    });
    expect(structured(listed).relationships).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "complementary-view",
          sourceId: sequenceId,
          targetId: flowId,
        }),
      ]),
    );

    const self = await client.callTool({
      name: "create_resource_relationship",
      arguments: { projectId, source: sequenceId, target: sequenceId },
    });
    expect(self.isError).toBe(true);
    const dangling = await client.callTool({
      name: "create_resource_relationship",
      arguments: { projectId, source: sequenceId, target: "missing-resource" },
    });
    expect(dangling.isError).toBe(true);
    await client.close();
  });

  it("creates a project when the credential has project:create", async () => {
    const bootstrapOwner = await harness.aUser("Bootstrap owner");
    const bootstrapToken = (
      await harness.aToken(bootstrapOwner, ["project:create", "project:read"])
    ).token;
    const client = await connect(bootstrapToken);
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toContain("create_project");

    const created = await client.callTool({
      name: "create_project",
      arguments: { name: "Created through MCP" },
    });
    expect(created.isError).toBeFalsy();
    expect(structured(created).project.name).toBe("Created through MCP");
    expect(structured(created).role).toBe("OWNER");
    expect(structured(created).project.workspaceId).toBeTruthy();

    const listed = await client.callTool({
      name: "list_projects",
      arguments: {},
    });
    expect(structured(listed).projects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "Created through MCP", role: "OWNER" }),
      ]),
    );
    await client.close();
  });

  it("lists accessible workspaces and requires explicit selection when there are several", async () => {
    const userId = await harness.aUser("Multi-workspace owner");
    await harness.service.runtime.workspaces.setMember(userId, userId, "ADMIN");
    const second = await harness.service.runtime.workspaces.create({ ownerId: userId, name: "Second workspace" });
    await harness.service.runtime.workspaces.setMember(second.id, userId, "ADMIN");
    const bearer = (await harness.aToken(userId, ["project:create", "project:read"])).token;
    const client = await connect(bearer);

    const workspaceResult = await client.callTool({ name: "list_workspaces", arguments: {} });
    expect(workspaceResult.isError).toBeFalsy();
    const available = structured(workspaceResult).workspaces;
    expect(available).toHaveLength(2);
    expect(available).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: second.id, name: "Second workspace", role: "ADMIN" }),
      expect.objectContaining({ isDefault: true }),
    ]));

    const ambiguous = await client.callTool({ name: "create_project", arguments: { name: "Must choose" } });
    expect(ambiguous.isError).toBe(true);
    expect(JSON.stringify(ambiguous)).toContain("Choose a workspace");
    const listedWithoutChoice = await client.callTool({ name: "list_projects", arguments: {} });
    expect(listedWithoutChoice.isError).toBe(true);

    const created = await client.callTool({ name: "create_project", arguments: { name: "In second", workspaceId: second.id } });
    expect(created.isError).toBeFalsy();
    expect(structured(created).project.workspaceId).toBe(second.id);
    const projects = await client.callTool({ name: "list_projects", arguments: { workspaceId: second.id } });
    expect(structured(projects).workspace).toMatchObject({ id: second.id, name: "Second workspace" });
    expect(structured(projects).projects).toEqual([expect.objectContaining({ name: "In second", workspaceId: second.id, workspaceName: "Second workspace" })]);
    await client.close();
  });

  it("lists projects and reports the caller's role", async () => {
    const client = await connect(token);
    const result = await client.callTool({
      name: "list_projects",
      arguments: {},
    });
    expect(result.isError).toBeFalsy();
    const data = structured(result);
    expect(Array.isArray(data.projects)).toBe(true);
    expect(data.projects[0].id).toBe(projectId);
    expect(data.projects[0].role).toBe("OWNER");
    await client.close();
  });

  it("creates, reads, updates and moves a resource", async () => {
    const client = await connect(token);

    const created = await client.callTool({
      name: "create_resource",
      arguments: {
        projectId,
        path: "checkout.seq",
        type: "sequence-diagram",
        content: "title Checkout\n",
      },
    });
    expect(created.isError).toBeFalsy();
    const resource = structured(created).resource;
    expect(resource.path).toBe("checkout.seq");
    expect(resource.revision).toBe(1);

    const read = await client.callTool({
      name: "read_resource",
      arguments: { projectId, resource: "checkout.seq" },
    });
    expect(structured(read).content).toBe("title Checkout\n");
    expect(structured(read).resource.revision).toBe(1);

    const updated = await client.callTool({
      name: "update_resource",
      arguments: {
        projectId,
        resource: resource.id,
        content: "title Checkout v2\n",
        expectedRevision: 1,
      },
    });
    expect(updated.isError).toBeFalsy();
    expect(structured(updated).resource.revision).toBe(2);

    const moved = await client.callTool({
      name: "move_resource",
      arguments: {
        projectId,
        resource: resource.id,
        path: "payments/checkout.seq",
        expectedRevision: 2,
      },
    });
    expect(moved.isError).toBeFalsy();
    expect(structured(moved).resource.path).toBe("payments/checkout.seq");

    await client.close();
  });

  it("returns a conflict as a tool error the model can act on", async () => {
    const client = await connect(token);
    const listed = await client.callTool({
      name: "list_resources",
      arguments: { projectId },
    });
    const resource = (structured(listed).resources as any[]).find(
      (entry) => entry.path === "payments/checkout.seq",
    );

    const stale = await client.callTool({
      name: "update_resource",
      arguments: {
        projectId,
        resource: resource.id,
        content: "title Stale\n",
        expectedRevision: 1,
      },
    });
    expect(stale.isError).toBe(true);
    expect(structured(stale).error.code).toBe("conflict");
    await client.close();
  });

  it("validates before writing a semantic upsert", async () => {
    const client = await connect(token);
    const bad = await client.callTool({
      name: "upsert_sequence_diagram",
      arguments: {
        projectId,
        path: "broken.seq",
        content: "this is not a diagram at all ][\n",
      },
    });
    expect(bad.isError).toBe(true);
    expect(structured(bad).error.code).toBe("validation");

    // Nothing was written.
    const listed = await client.callTool({
      name: "list_resources",
      arguments: { projectId },
    });
    expect(
      (structured(listed).resources as any[]).some(
        (entry) => entry.path === "broken.seq",
      ),
    ).toBe(false);
    await client.close();
  });

  it("reads project content as MCP resources, not public URLs", async () => {
    await harness.aSharedResource(projectId, "shared-resource.seq", "participant A\n");
    const client = await connect(token);
    const listed = await client.listResources();
    expect(listed.resources.length).toBeGreaterThan(0);
    const resource = listed.resources.find((entry) =>
      entry.uri.includes("resources/"),
    );
    expect(resource).toBeDefined();
    const read = await client.readResource({ uri: resource!.uri });
    const first = read.contents[0] as { text?: string };
    expect(typeof first.text).toBe("string");
    await client.close();
  });

  it("paginates a listing without returning the whole project", async () => {
    const client = await connect(token);
    // Two resources are needed before a one-item page can have a successor.
    await client.callTool({
      name: "create_resource",
      arguments: {
        projectId,
        path: "second.seq",
        type: "sequence-diagram",
        content: "title Second\n",
      },
    });
    const first = await client.callTool({
      name: "list_resources",
      arguments: { projectId, limit: 1 },
    });
    const data = structured(first);
    expect(data.resources).toHaveLength(1);
    expect(typeof data.nextCursor).toBe("string");

    const second = await client.callTool({
      name: "list_resources",
      arguments: { projectId, limit: 1, cursor: data.nextCursor },
    });
    expect(structured(second).resources[0].id).not.toBe(data.resources[0].id);
    await client.close();
  });

  it("searches a project and returns snippets rather than files", async () => {
    const client = await connect(token);
    const result = await client.callTool({
      name: "search_project",
      arguments: { projectId, query: "Checkout" },
    });
    expect(result.isError).toBeFalsy();
    const data = structured(result);
    expect(Array.isArray(data.results)).toBe(true);
    for (const hit of data.results) {
      expect(hit.snippet.length).toBeLessThan(400);
      expect(hit.path).toBeDefined();
    }
    await client.close();
  });

  it("validates a project and reports diagnostics", async () => {
    const client = await connect(token);
    const result = await client.callTool({
      name: "validate_project",
      arguments: { projectId },
    });
    expect(result.isError).toBeFalsy();
    expect(Array.isArray(structured(result).diagnostics)).toBe(true);
    await client.close();
  });

  it("keeps MCP MY WORK validation aligned with browser analysis for Database and Conceptual", async () => {
    const validationProjectId = await harness.aProject(ownerId, "Artifact validation");
    discoveryProjectToDelete = validationProjectId;
    const validationContextId = (await harness.service.runtime.knowledgeContexts.createPrivate({
      projectId: validationProjectId,
      ownerUserId: ownerId,
      name: "Artifact validation work",
    })).id;
    const client = await connect(token, validationContextId);
    const invalidDatabase = [
      "// unsupported comment syntax",
      'table sample - "sample"',
      'column sample id "id" {uuid} not-null',
      'column sample note "note" {text}',
      "primary-key sample_pk sample (id)",
    ].join("\n");
    const created = await client.callTool({
      name: "create_resource",
      arguments: {
        projectId: validationProjectId,
        path: "validation/database.dbschema",
        type: "database",
        content: 'table sample - "sample"\ncolumn sample id "id" {uuid} not-null\nprimary-key sample_pk sample (id)',
      },
    });
    expect(created.isError).toBeFalsy();
    const resourceId = structured(created).resource.id as string;
    const firstUpdate = await client.callTool({
      name: "update_resource",
      arguments: { projectId: validationProjectId, resource: resourceId, content: invalidDatabase, expectedRevision: 1 },
    });
    expect(firstUpdate.isError).toBeFalsy();
    const secondUpdate = await client.callTool({
      name: "update_resource",
      arguments: { projectId: validationProjectId, resource: resourceId, content: invalidDatabase, expectedRevision: 2 },
    });
    expect(secondUpdate.isError).toBeFalsy();
    expect(structured(secondUpdate).resource.revision).toBe(3);

    const persisted = await client.callTool({ name: "read_resource", arguments: { projectId: validationProjectId, resource: resourceId } });
    expect(structured(persisted).resource.revision).toBe(3);
    expect(structured(persisted).content).toBe(invalidDatabase);
    const browserDatabase = analyzeResource({ id: resourceId, projectId: validationProjectId, path: "validation/database.dbschema", type: "database", title: "Database" }, invalidDatabase);
    expect(browserDatabase.diagnostics.filter((diagnostic) => diagnostic.severity === "error").length).toBeGreaterThan(0);
    const invalidDatabaseValidation = await client.callTool({ name: "validate_project", arguments: { projectId: validationProjectId } });
    const mcpDatabaseCodes = structured(invalidDatabaseValidation).diagnostics.map((diagnostic: { code: string }) => diagnostic.code);
    expect(mcpDatabaseCodes).toEqual(expect.arrayContaining(browserDatabase.diagnostics.filter((diagnostic) => diagnostic.severity === "error").map((diagnostic) => String(diagnostic.code))));

    const validDatabase = 'table sample - "sample"\ncolumn sample id "id" {uuid} not-null\ncolumn sample note "note" {text} nullable\nprimary-key sample_pk sample (id)';
    const validDatabaseUpdate = await client.callTool({
      name: "update_resource",
      arguments: { projectId: validationProjectId, resource: resourceId, content: validDatabase, expectedRevision: 3 },
    });
    expect(validDatabaseUpdate.isError).toBeFalsy();
    expect(structured(validDatabaseUpdate).resource.revision).toBe(4);
    const validDatabaseValidation = await client.callTool({ name: "validate_project", arguments: { projectId: validationProjectId } });
    expect(structured(validDatabaseValidation).diagnostics).toEqual([]);
    const parsedDatabase = parseDatabase(validDatabase);
    expect(parsedDatabase.model).not.toBeNull();
    const databaseProjection = projectDatabase(parsedDatabase.model!);
    expect((await layoutGeometry(databaseProjection.geometry)).items).toHaveLength(1);

    const invalidConceptual = 'concept customer "Customer"\nrelation owns customer -> missing "owns"';
    const conceptualCreated = await client.callTool({
      name: "create_resource",
      arguments: { projectId: validationProjectId, path: "validation/conceptual.concept", type: "conceptual", content: invalidConceptual },
    });
    expect(conceptualCreated.isError).toBeFalsy();
    const conceptualId = structured(conceptualCreated).resource.id as string;
    const browserConceptual = analyzeResource({ id: conceptualId, projectId: validationProjectId, path: "validation/conceptual.concept", type: "conceptual", title: "Conceptual" }, invalidConceptual);
    expect(browserConceptual.diagnostics.filter((diagnostic) => diagnostic.severity === "error").length).toBeGreaterThan(0);
    const invalidConceptualValidation = await client.callTool({ name: "validate_project", arguments: { projectId: validationProjectId } });
    const mcpConceptualCodes = structured(invalidConceptualValidation).diagnostics.map((diagnostic: { code: string }) => diagnostic.code);
    expect(mcpConceptualCodes).toEqual(expect.arrayContaining(browserConceptual.diagnostics.filter((diagnostic) => diagnostic.severity === "error").map((diagnostic) => String(diagnostic.code))));

    const validConceptual = 'concept customer "Customer"\nconcept account "Account"\nrelation owns customer -> account "owns"';
    const conceptualUpdate = await client.callTool({
      name: "update_resource",
      arguments: { projectId: validationProjectId, resource: conceptualId, content: validConceptual, expectedRevision: 1 },
    });
    expect(conceptualUpdate.isError).toBeFalsy();
    expect(analyzeResource({ id: conceptualId, projectId: validationProjectId, path: "validation/conceptual.concept", type: "conceptual", title: "Conceptual" }, validConceptual).diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);
    const validConceptualValidation = await client.callTool({ name: "validate_project", arguments: { projectId: validationProjectId } });
    expect(structured(validConceptualValidation).diagnostics).toEqual([]);
    await client.close();
  });

  it("exposes proposal target capabilities and detailed validation diagnostics", async () => {
    const client = await connect(token);
    const created = await client.callTool({
      name: "create_resource",
      arguments: {
        projectId,
        path: "proposal-invalid.eventseq",
        type: "event-flow",
        content: "event Broken extra",
      },
    });
    const resourceId = structured(created).resource.id;
    const submitted = await client.callTool({
      name: "submit_architectural_proposal",
      arguments: {
        projectId,
        sourcePrivateContextId: contextId,
        resourceIds: [resourceId],
        title: "Invalid proposal fixture",
      },
    });
    const proposalId = structured(submitted).proposal.id;

    const proposal = await client.callTool({
      name: "get_architectural_proposal",
      arguments: { projectId, proposalId },
    });
    expect(structured(proposal).capabilities["proposal.review"]).toMatchObject({
      allowed: false,
      reason: "self_review",
    });
    expect(structured(proposal).proposal.staleBase).toBe(false);
    expect(structured(proposal).capabilities["proposal.previewPromotion"]).toMatchObject({ allowed: true });
    expect(structured(proposal).capabilities["proposal.promote"]).toMatchObject({ allowed: false });

    const reviews = await client.callTool({
      name: "list_architectural_proposal_reviews",
      arguments: { projectId, proposalId },
    });
    expect(structured(reviews).reviews.reviews).toHaveLength(0);

    const preview = await client.callTool({
      name: "preview_architectural_proposal_promotion",
      arguments: { projectId, proposalId },
    });
    expect(structured(preview).preview).toMatchObject({ eligible: false, reviewStatus: "none" });
    expect(structured(preview).preview.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "REVIEW_REQUIRED" }),
    ]));

    const validation = await client.callTool({
      name: "validate_architectural_proposal",
      arguments: { projectId, proposalId },
    });
    const diagnostics = structured(validation).diagnostics;
    expect(diagnostics.length).toBeGreaterThan(0);
    expect(diagnostics[0]).toMatchObject({ severity: expect.any(String), resourceId: expect.any(String), path: "proposal-invalid.eventseq", message: expect.any(String) });
    await client.close();
  });
});
