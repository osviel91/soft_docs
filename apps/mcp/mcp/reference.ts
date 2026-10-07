import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  DSL_CONSTRUCTS,
  EVENT_FLOW_CONSTRUCTS,
  SEQUENCE_SEMANTIC_MESSAGING_GUIDANCE,
} from "../../../src/language/dsl-reference";
import {
  ARTIFACT_GUIDANCE,
  ARTIFACT_GUIDANCE_URI,
} from "../../../src/language/artifact-guidance";
export { ARTIFACT_GUIDANCE_URI };

export const SEQUENCE_DSL_URI = "seqdocs://reference/sequence-dsl";
export const EVENT_FLOW_DSL_URI = "seqdocs://reference/event-flow-dsl";
export const SEMANTIC_BINDING_URI = "seqdocs://reference/semantic-binding";
// Governance is remote-only: stdio serves the separate local-first contract.
export const GOVERNANCE_GUIDE_URI = "seqdocs://reference/mcp-governance";
const GOVERNANCE_GUIDE_PATH = join(
  process.cwd(),
  "docs",
  "skills",
  "mcp-governance.md",
);

function eventFlowDslText(): string {
  return [
    "# Event Flow language",
    "",
    "The `*.eventseq` language supports topology, explicit causality, and evidence-backed failure/recovery semantics. Do not infer retry behavior from queues or asynchronous messaging; absent policy fields remain unknown.",
    "Read this before authoring an event flow.",
    "",
    "## Semantic authoring and progressive enrichment",
    "",
    "A SemanticMessageIdentity is a stable project-scoped architectural identity. Its human-readable name is not its identity: `messageRef` is the explicit binding. One identity may have many Sequence occurrences and Event Flow entities. Event and command are independent message kinds; publish, consume, and dispatch are occurrence operations. Use structured semantics only when evidence establishes asynchronous message behavior, never infer kind from a name suffix, and leave an occurrence valid and unbound when identity is not yet known.",
    "",
    "Before binding, call `list_semantic_messages`, `list_semantic_occurrences`, and `find_semantic_message_candidates`. Determine from evidence whether equal or similar names are the same architectural message; reuse an authoritative identity or call `create_semantic_message` with only name and kind, receive its server-generated id, then bind each exact occurrence and verify with `get_semantic_message`. Never invent a UUID. A cross-view message binding does not imply a `complementary-view` relationship. Create that relationship only when the Sequence and Event Flow are substantially the same behavior viewed through execution and causality.",
    "Use `trace_architecture` for bounded upstream/downstream/both traversal from a stable message identity or exact indexed occurrence. It returns authoritative graph facts plus explicit candidate and unknown boundaries; never infer cross-resource connections from equal names.",
    "",
    "When improving legacy documentation, inspect first and report conservative enrichment candidates: unstructured message-like Sequence calls, structured but unbound occurrences, Event Flow entities without `messageRef`, missing useful descriptions/tags, prose-only retry/failure facts, and untyped complementary projections. Apply only evidenced targeted changes and validate afterward; do not rewrite the project automatically.",
    "",
    "New resources normally include a concise architectural description and useful evidence-backed tags. Notes/details are selective and preserve conditions, uncertainty, constraints, rationale, boundaries, transformations, delivery/idempotency/retry facts, or other information not represented by the diagram. Do not invent metadata.",
    "",
    ...EVENT_FLOW_CONSTRUCTS.flatMap((construct) => [
      `## ${construct.name}`,
      "",
      "```text",
      construct.syntax,
      "```",
      "",
      construct.summary,
      "",
      "Example:",
      "",
      "```text",
      construct.example,
      "```",
      "",
    ]),
  ].join("\n");
}

function sequenceReferenceText(): string {
  return [
    "# Sequence diagram language",
    "",
    "The `*.seq` language for ordered interactions. Read this before authoring a Sequence.",
    "",
    ...DSL_CONSTRUCTS.flatMap((construct) => [
      `## ${construct.name}`,
      "",
      "```text",
      construct.syntax,
      "```",
      "",
      construct.summary,
      "",
      "Example:",
      "",
      "```text",
      construct.example,
      "```",
      "",
    ]),
    SEQUENCE_SEMANTIC_MESSAGING_GUIDANCE,
  ].join("\n");
}

const SEMANTIC_BINDING_GUIDANCE = `# Semantic binding MCP reference

Semantic bindings connect typed Conceptual/Database entities using explicit evidence. They are separate from semantic message identities and resource relationships. Equal or similar names are discovery hints only, never evidence.

## Discover exact anchors

Call \`get_project_index\` with the project id and the owned MY WORK \`contextId\`:

\`\`\`json
{ "projectId": "<project-id>", "contextId": "<my-work-context-id>" }
\`\`\`

Find \`entities\` by \`displayName\`; each result includes \`resourceId\`, \`representation\`, \`entityKind\`, stable \`identity\`, exact \`anchor\`, \`resolution\`, and \`contextId\`. Copy the returned \`anchor\` values literally. Do not reconstruct an anchor from a name, path, or DSL.

## Evidence-backed example

Assume the index returns a Conceptual entity named \`recharge-registry\` and a Database table named \`programmed_recharges_events\`. Use the exact returned anchors below (the values are illustrative; callers must substitute the actual objects returned by the index):

\`\`\`json
{
  "left": { "version": 1, "resourceId": "concept-resource-id", "representation": "conceptual", "entityKind": "concept", "identity": { "kind": "local-id", "value": "recharge-registry" } },
  "right": { "version": 1, "resourceId": "database-resource-id", "representation": "database", "entityKind": "table", "identity": { "kind": "local-id", "value": "programmed_recharges_events" } }
}
\`\`\`

Then call \`create_semantic_binding\` with the same \`projectId\` and MY WORK \`contextId\`:

\`\`\`json
{
  "binding": {
    "id": "f4c6d93e-f19c-4f72-a9bc-2966fc9cb5ea",
    "left": { "version": 1, "resourceId": "concept-resource-id", "representation": "conceptual", "entityKind": "concept", "identity": { "kind": "local-id", "value": "recharge-registry" } },
    "right": { "version": 1, "resourceId": "database-resource-id", "representation": "database", "entityKind": "table", "identity": { "kind": "local-id", "value": "programmed_recharges_events" } },
    "relation": "represents-in",
    "evidence": {
      "version": 1,
      "rationale": "BillingMiddleware persists recharge registry events through the ORM mapping to this table.",
      "items": [{ "kind": "external", "reference": "src/billing/BillingMiddleware.ts and migrations/2024xxxx_programmed_recharges_events.sql", "description": "ORM entity/table mapping and migration define the persisted recharge event records." }]
    }
  }
}
\`\`\`

The anchor objects in the create request must be copied literally from the entity results; illustrative IDs above are not real identities. Evidence must cite repository, migration, or other observed source material that establishes the mapping. Name coincidence alone does not establish it. Updates also require \`expectedRevision\`, the revision read from \`get_semantic_binding\`; stale revisions return a conflict.
`;

export function registerMcpReferences(server: {
  registerResource: (
    name: string,
    uri: string,
    metadata: {
      title: string;
      description: string;
      mimeType: string;
    },
    read: (uri: URL) => Promise<{
      contents: Array<{ uri: string; mimeType: string; text: string }>;
    }>,
  ) => unknown;
}): void {
  server.registerResource(
    "artifact-authoring-guidance",
    ARTIFACT_GUIDANCE_URI,
    {
      title: "Artifact selection and authoring guidance",
      description:
        "Purpose, semantics, canonical source examples, inference boundaries, editing rules, and current product capabilities for all five artifact types.",
      mimeType: "text/markdown",
    },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "text/markdown", text: ARTIFACT_GUIDANCE }],
    }),
  );
  server.registerResource(
    "mcp-governance",
    GOVERNANCE_GUIDE_URI,
    {
      title: "MCP knowledge governance",
      description: "The canonical agent workflow for SHARED, MY WORK, PROPOSAL, REVIEW, and PROMOTION.",
      mimeType: "text/markdown",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "text/markdown",
          text: await readFile(GOVERNANCE_GUIDE_PATH, "utf8"),
        },
      ],
    }),
  );
  server.registerResource(
    "sequence-dsl",
    SEQUENCE_DSL_URI,
    {
      title: "Sequence diagram language reference",
      description:
        "The supported Sequence syntax and canonical architectural messaging authoring guidance.",
      mimeType: "text/markdown",
    },
    async (uri) => ({
      contents: [
        { uri: uri.href, mimeType: "text/markdown", text: sequenceReferenceText() },
      ],
    }),
  );
  server.registerResource(
    "event-flow-dsl",
    EVENT_FLOW_DSL_URI,
    {
      title: "Event Flow language reference",
      description:
        "The supported event-flow topology and causal authoring syntax, with examples.",
      mimeType: "text/markdown",
    },
    async (uri) => ({
      contents: [
        { uri: uri.href, mimeType: "text/markdown", text: eventFlowDslText() },
      ],
    }),
  );
  server.registerResource(
    "semantic-binding",
    SEMANTIC_BINDING_URI,
    {
      title: "Semantic binding MCP reference",
      description: "Discover exact bindable entity anchors and author evidence-backed semantic bindings.",
      mimeType: "text/markdown",
    },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: SEMANTIC_BINDING_GUIDANCE }] }),
  );
}
