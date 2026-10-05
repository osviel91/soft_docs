/** Shared agent-facing contract exposed by both MCP hosts. */
export const ARTIFACT_GUIDANCE_URI =
  "sequencediagrams://reference/artifact-authoring";

export const ARTIFACT_GUIDANCE = `# Artifact selection and authoring guidance

Purpose and semantic support are independent of renderer maturity. This guide describes supported source semantics and separately reports current product capabilities. Read it before choosing or editing an artifact.

## Choose by intent

| Artifact | Use when | Do not use for |
| --- | --- | --- |
| Markdown (\`.md\`) | Narrative, rationale, decisions, rules, and explanatory context | Structured execution, causal topology, or schema facts as a substitute for their own representations |
| Sequence (\`.seq\`) | Ordered interactions and execution between participants | Asynchronous causality by itself |
| Event Flow (\`.eventseq\`) | Event publication/consumption topology and explicitly authored causal facts | Inferred causality from topology, synchronous HTTP, or service topology alone |
| Conceptual Diagram (\`.concept\`) | Important domain/system concepts and explicitly authored conceptual relationships | Execution order, message topology, event causality, database schema, service dependency, or UML class modeling |
| Database Diagram (\`.dbschema\`) | Persistent structure: schemas when known, tables, columns, keys, constraints, indexes, defaults, and documented structural relationships | Service topology, runtime dependency, business process, event/causal flow, or conceptual domain modeling |

Choose according to the user's explicit intent. For “main business concepts and how they relate,” use Conceptual; for “order Checkout calls downstream systems,” Sequence; for “which service publishes and consumes OrderCreated,” Event Flow; for “orders, customers, PKs and FKs,” Database; and for “why this decision exists,” Markdown.

## Conceptual Diagram — \`conceptual\` / \`.concept\`

A Conceptual Diagram documents important concepts in a domain, system, or architectural context and the explicitly authored relationships between those concepts. It answers what concepts matter, how they relate, which relationships are directional, and what vocabulary the context uses.

Concepts have explicit stable IDs; display names are independent. Preserve an ID when the same concept is renamed. Relationship IDs are explicit, stable, and resource-local. Labels are required authored open text; do not use a label as identity. Directed \`->\` and undirected \`--\` relationships are semantically different. Self-relationships, parallel relationships, cycles, and isolated concepts are valid. Duplicate display names do not establish identity. Omission means “not documented here,” not “does not exist.” Do not invent mandatory Concept kinds.

Canonical source examples (the declarations are valid \`.concept\` DSL):

### Minimal directed relationship

\`\`\`text
title "Commerce concepts"
concept customer "Customer"
concept order "Order"
relation places customer -> order "places orders"
\`\`\`

### Undirected relationship

\`\`\`text
concept customer "Customer"
concept account "Account"
relation associated customer -- account "associated with"
\`\`\`

### Rename while preserving identity

Before: \`concept customer "Customer"\`. After: \`concept customer "Account Holder"\`. Preserve \`customer\` because the semantic concept remains the same; a display-name change is not a new identity.

### Parallel relationships, self-relationship, and isolated concept

\`\`\`text
concept customer "Customer"
concept account "Account"
concept prospect "Prospect"
relation owns customer -> account "owns"
relation manages customer -> account "manages"
relation relates account -- account "related to itself"
\`\`\`

Changing a relationship's label, direction, endpoint, or description should normally preserve its ID if it remains the same conceptual relationship. Do not infer relationship identity from labels. Add relationships only from user instruction or repository/architectural evidence. Equal labels do not prove identity, including across resources.

A Conceptual relationship means exactly its authored relation in that resource. It does not automatically imply runtime/code/service dependency, event publication/consumption, execution sequence, causality, or a database foreign key. Absence is not proof of non-relationship.

## Database Diagram — \`database\` / \`.dbschema\`

A Database Diagram documents persistent data structure: schemas when known, tables, columns, primary keys, foreign keys, uniqueness constraints, indexes, defaults, and explicitly documented structural relationships. It answers what tables/columns are documented, what identifies rows, which documented FKs connect structures, and which uniqueness/index constraints are documented.

Tables have explicit stable IDs independent of table names; preserve the ID on table rename. Foreign-key IDs are explicit and stable. Columns use explicit IDs when supplied; an explicit column ID preserves rename continuity. Without one, identity is conservatively \`(table ID, exact column name)\`; do not claim rename continuity. Schema is optional; \`-\` means no schema is documented, not a default schema. Data types and defaults are opaque authored text. PK, FK, unique constraints, indexes, and ordered composite keys/mappings are structural evidence. Self-FKs are allowed. Omission means “not documented here.” Do not introduce dialect-specific interpretation.

Canonical source examples (the declarations are valid \`.dbschema\` DSL):

### Simple table and primary key

\`\`\`text
table customers - "customers"
column customers customer_id "id" {uuid} not-null
primary-key customers_pk customers (id)
\`\`\`

### Two tables and foreign key

\`\`\`text
table customers - "customers"
column customers customer_id "id" {uuid} not-null
primary-key customers_pk customers (id)
table orders - "orders"
column orders order_id "id" {uuid} not-null
column orders - "customer_id" {uuid} not-null
primary-key orders_pk orders (id)
foreign-key orders_customer orders (customer_id) -> customers (id)
\`\`\`

### Explicit column IDs and rename continuity

\`\`\`text
table accounts - "accounts"
column accounts account_id "id" {uuid} not-null
column accounts holder_id "customer_id" {uuid} not-null
primary-key accounts_pk accounts (id)
\`\`\`

Rename \`customer_id\` to \`account_holder_id\` by changing only its display name and keeping \`holder_id\`. For a column without an explicit ID, identity remains exact-name based and a rename is not proven to be continuous.

### Composite primary and foreign keys

\`\`\`text
table memberships - "memberships"
column memberships tenant_id "tenant_id" {uuid} not-null
column memberships user_id "user_id" {uuid} not-null
primary-key memberships_pk memberships (tenant_id, user_id)
table permissions - "permissions"
column permissions permission_tenant_id "tenant_id" {uuid} not-null
column permissions permission_user_id "user_id" {uuid} not-null
column permissions role "role" {text} not-null
primary-key permissions_pk permissions (tenant_id, user_id, role)
foreign-key permissions_membership permissions (tenant_id, user_id) -> memberships (tenant_id, user_id)
\`\`\`

Composite column order is meaningful; preserve ordered FK mappings. A target FK mapping must match a declared PK or unique key in order.

### Unique, index, default, and optional schema

\`\`\`text
schema commerce "commerce"
table products commerce "products"
column products product_id "id" {uuid} not-null
column products sku "sku" {text} not-null
column products status "status" {text} not-null default {'active'}
primary-key products_pk products (id)
unique products_sku products (sku)
index products_status_idx products (status)
\`\`\`

Use \`-\` in a table's schema position when schema is undocumented. Types/defaults are opaque; do not infer vendor behavior.

An FK does not by itself prove service ownership/dependency, runtime call direction, event or causal dependency, aggregate boundary, or business cardinality. A junction table does not automatically prove a business many-to-many relationship. Derive cardinality only from contract-permitted explicit structural evidence; otherwise it remains unknown. Add constraints and relationships only from user instruction or evidence. Same labels never establish cross-artifact identity: IDs are resource-local absent explicit binding evidence.

## Current product capabilities

Capabilities below describe user-visible product behavior, not available internal modules. Semantic meaning above does not change when capabilities mature.

| Capability | Conceptual | Database |
| --- | --- | --- |
| Source authoring and validation | Yes | Yes |
| MY WORK, proposals, review/governance, promotion | Yes | Yes |
| Semantic review | Yes (semantic diff) | Yes (Database semantic diff) |
| Product visual rendering | Yes | Yes |
| Public Share rendering | Yes | Yes |
| Presentation rendering | Yes | Yes |

Malformed source is a validation failure. Database comparison uses stable table/FK IDs and explicit column IDs; implicit columns retain exact-name identity. Composite FK review preserves ordered mappings. Geometry and selection are not semantic changes.
A valid resource requested in a surface that does not render it is an unsupported capability, not invalid source.

## Safe editing and governance

Discover existing SHARED knowledge first. Preserve authored stable IDs whenever evidence shows identity persists; never regenerate IDs wholesale or infer identity from display-name similarity. Missing evidence stays unknown; do not complete a diagram by guessing. Add concepts, relations, tables, FKs, keys, or constraints only from explicit user instruction or repository/architectural evidence.

In governed server projects, use the existing generic lifecycle: inspect SHARED, edit owned MY WORK, explicitly submit a selected immutable proposal, obtain independent review, and explicitly promote when authorized. Understanding a DSL grants no SHARED authority. Do not bypass governance for machine-authored resources. Use generic resource operations; no artifact-specific mutation tools are needed. MCP authorization remains authoritative.

Sequence remains ordered execution; Event Flow topology remains distinct from explicit causal facts. Causality requires authored evidence, never topology alone. Conceptual/Database structures do not create Sequence or Event Flow semantics.
`;
