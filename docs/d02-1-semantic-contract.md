# D02.1 — Semantic Contract and Authoring Spike

**Status:** APPROVED contract direction; source-format recommendation from a documentation spike; no artifact support implemented.
**Baseline:** `1f879c050c50da1b0fee34dcc7a17fb2089381b3`; D02 discovery commit `180893b208d3f35691d9b32e661945ecf3d867c9`.

This resolves the D02 implementation blockers. It is normative for the first parser/model phase. Examples specify semantic content and candidate syntax, not a production grammar. Normative knowledge/evidence rules remain in [documentation-model.md](documentation-model.md).

## Approved decisions

| Decision | Contract |
|---|---|
| Conceptual model | Dedicated `ConceptualModel { title?, description?, concepts[], relationships[] }`; no generic graph domain type. |
| Concept | Required resource-local `id`, display `name`, optional `description`; no mandatory kind or arbitrary metadata bag. |
| Concept ID | Explicit authored stable local ID, independent of name; scoped by resource. Rename the name without changing ID. |
| Relationship | Required stable local `id`, source/target concept IDs, required authored label, direction, optional description. |
| Relationship direction | V1 `directed` or `undirected`; directed is the default. No separate `bidirectional` value: author the reverse statement with its own identity when both directions are intended. |
| Relationship vocabulary | Open authored label; never a platform enum. No UML composition/aggregation semantics. |
| Relationship identity | Explicit authored local ID; endpoint or label changes preserve that ID. |
| Concept kind | No kind in V1. Add optional classification only with concrete semantic queries/validation that need it. |
| Cross-artifact identity | Deferred; any future binding is explicit and evidence-backed. Local IDs neither imply nor preclude it. |
| Closed-world semantics | None. Omitted concepts/relationships do not prove absence. |
| Database model | Dedicated `DatabaseModel { title?, description?, schemas[], tables[] }`; constraints are schema facts owned by tables or modeled as typed top-level FK facts, never graph nodes. |
| Schema | Optional namespace; an omitted schema is the implicit namespace. Schema IDs are local/stable when explicitly declared. Same table name in different schemas is valid. |
| Table ID | Required explicit local stable ID, independent of schema and display name; moving/renaming a table preserves identity. |
| Column ID | Optional explicit local stable ID; otherwise identity is `(tableId, columnName)`. Author explicit IDs when rename continuity matters. This avoids ID boilerplate on every column while making continuity evidence explicit. |
| Foreign-key ID | Required explicit local stable ID; endpoint/column mapping edits preserve it. Constraint names are optional labels, not identity. |
| Type | Opaque authored type string. No platform or dialect-specific type object. Exact textual changes are modifications. |
| Nullability | Required known boolean for authored columns in V1; unknown/nullability uncertainty is not silently defaulted. Future importers may need an unknown state. |
| Keys and constraints | PK and FK required V1 semantics; unique constraints SHOULD be supported in V1. Composite PK/FK/unique column lists retain order. |
| Index/default | Indexes SHOULD be supported in V1 as their own facts, distinct from unique constraints. Optional opaque default expression text is supported. |
| Remaining DB scope | Check/generated columns/views/materialized views later; procedures/triggers out of V1. |
| Cardinality | Derive only structural bounds proven by FK, uniqueness, and known nullability. Otherwise unknown. No business cardinality inference. |
| Completeness | No V1 complete/partial flag. Omission means undocumented here. Scope/provenance/completeness can be added when importer and source boundaries are designed. |
| Source syntax | Recommend dedicated declarative DSL, independent of semantic models. YAML was evaluated and remains a possible import/interchange format, not the canonical authoring source. |
| Resource types/extensions | `conceptual` / `.concept`; `database` / `.dbschema`. Do not use `.db` (binary-file collision), `.schema` (generic collision), or renderer-coupled names. |
| Content type | Existing resource content remains text; classify through resource type/extension as current artifacts do. No custom MIME infrastructure. |
| Formatting/layout | No formatter required for first implementation. Preserve author order for source display, but order is not semantic identity. No authored coordinates/manual layout. No layout engine selected. |
| Governance | Existing LOCAL, SHARED, MY WORK, proposal, ShareGrant, Presentation, and MCP authority remain unchanged. |

V1 semantic elements deliberately exclude renderer sizes, coordinates, ports, colors, node/edge abstractions, and SQL parser structures. Source comments are discarded by parsing; explicit `description` is semantic content. Resource-level title/description may be represented in source metadata in the eventual grammar; they are not inferred from comments.

## Semantic contracts and invariant rules

### Conceptual

`ConceptualModel` contains optional title/description, `Concept[]`, and `ConceptualRelationship[]`. A Concept is `{ id, name, description? }`. A relationship is `{ id, sourceConceptId, targetConceptId, label, direction: "directed" | "undirected", description? }`. IDs are non-empty, unique within their respective collections and scoped by resource. Names need not be unique. Relationship labels are required non-empty authored statements. There is no generic metadata record; add typed fields only when a semantic use case warrants them.

| Condition | Result |
|---|---|
| Duplicate concept ID / relationship ID | ERROR |
| Unknown source or target concept ID | ERROR |
| Empty/whitespace label or invalid direction | ERROR |
| Self-relationship | ALLOWED |
| Multiple relationships between same endpoints | ALLOWED, including different labels/directions; exact duplicate statements may receive WARNING only if unambiguous to detect |
| Duplicate display names | ALLOWED; optional INFO for discoverability, never identity conflict |
| Cycle | ALLOWED |
| Isolated concept | ALLOWED; INFO at most |
| No relationship declaration between two concepts | UNKNOWN, not a negative fact |

### Database

`DatabaseModel` contains optional title/description, optional schema declarations, and tables. A Table has `{ id, schemaId?, name, description?, columns[], primaryKey?, uniqueConstraints[], indexes[] }`. A Column has `{ id?, name, type, nullable, default?, description? }`. Each column has a stable key: its explicit ID if present, otherwise `(tableId, exact column name)`. PK/unique/index definitions reference column keys and have stable authored IDs where individual identity matters. FK is `{ id, sourceTableId, sourceColumns[], targetTableId, targetColumns[], name? }`, with explicit ordered mappings. It is independent of its later visual line. All IDs are resource-local; schema-qualified names are lookup/display paths, not identity.

Types and defaults remain opaque source text. No DB-engine type compatibility or SQL expression validation is claimed. Foreign-key arity must match; each column must resolve; each referenced target tuple should identify a declared PK/unique key for a fully validated relational FK. If not, report ERROR for an invalid declared target under this generic relational contract, not a guessed dialect rule. Names/case are exact and case-sensitive in the neutral model; a future dialect importer must preserve dialect rules/provenance rather than rewrite them silently.

| Condition | Result |
|---|---|
| Duplicate table/schema/column/constraint ID | ERROR |
| Duplicate table name within same optional schema | ERROR; same name across distinct schemas ALLOWED |
| Duplicate column name within table | ERROR |
| PK/unique/index/FK references missing column; FK missing table | ERROR |
| Composite FK source/target arity mismatch | ERROR |
| Duplicate constraint name in its owner scope | ERROR; unnamed constraints allowed when stable IDs exist |
| Nullable PK column | ERROR |
| Self-referencing FK | ALLOWED |
| Unknown type spelling | ALLOWED (opaque type); INFO only if importer/parser cannot preserve it |
| Unreferenced table/column; no FK/index declaration | ALLOWED; no claim of real-world absence |
| Uniqueness/index/default omitted | Unknown/not documented; not proof of absence |

A nullable FK permits a row to have no target only when all its source columns are nullable; mixed composite nullability, SQL MATCH behavior, partial constraints, and engine-specific rules prevent stronger claims. A unique source FK tuple plus FK target uniqueness supports one-to-one maximum participation; otherwise it is many-to-one from source to target. The inverse is one-to-many. Minimum participation is optional only when source FK columns are all non-null; otherwise optional. Do not infer business ownership or N:M from the diagram. A junction table with two FKs is the explicit structural representation of an associative pattern, not proof of a business-level N:M claim.

### Semantic diff consequences

Match Conceptual concepts/relationships, Database schemas/tables/columns/constraints/FKs by authored local ID. Report rename/modify when IDs persist; e.g. concept name change is `ModifyConcept`, table/schema move is `ModifyTable`, relationship endpoint change is `ModifyRelationship`, and FK mapping change is `ModifyForeignKey`. Optional column ID permits `customer_id -> buyer_id` as `ModifyColumn`; without it, the documented fallback identity changes and the conservative result is remove/add. Type string change is `ModifyColumn(type)`. Do not use name similarity to silently convert add/remove into rename.

These identities support future operations (`Add/Remove/ModifyConcept`, relationship, table, column, key/constraint/FK) and proposal evidence. No diff engine or binding mechanism is introduced here.

## Authoring spike: realistic equivalent examples

These examples intentionally show the same identities and facts in both candidates. `#` comments are source comments, not semantic descriptions. The DSL form illustrates one candidate syntax; it is not a frozen grammar.

### Conceptual example

```text
title "Commerce concepts"
description "Structural domain facts; not an execution or causal model."
concept customer "Customer" {
  description: "A person or organization placing an order."
}
concept order "Order"
concept product "Product"
concept payment "Payment"
concept refund "Refund"
concept archived_order "Archived order"
concept 雪 "注文者"

relation customer_places_order customer -> order "places"
relation order_contains_product order -> product "contains"
relation order_is_paid_by order -> payment "is paid by"
relation payment_refund payment -> refund "may create" {
  description: "A successful reversal may produce this outcome."
}
# Parallel statements are separate facts.
relation customer_reviews_order customer -> order "reviews"
# Self-relations and cycles are allowed.
relation product_substitutes_product product -> product "may substitute for"
relation a_to_b a -> b "connects"
relation b_to_c b -> c "connects"
relation c_to_a c -> a "connects"
relation customer_knows_customer customer -- customer "knows" # `--` illustrates undirected
concept a "A"
concept b "B"
concept c "C"
```

### YAML equivalent

```yaml
kind: conceptual
title: Commerce concepts
description: Structural domain facts; not an execution or causal model.
concepts:
  - id: customer
    name: Customer
    description: A person or organization placing an order.
  - id: order
    name: Order
  - id: product
    name: Product
  - id: payment
    name: Payment
  - id: refund
    name: Refund
  - id: archived_order
    name: Archived order
  - id: 雪
    name: 注文者
  - id: a
    name: A
  - id: b
    name: B
  - id: c
    name: C
relationships:
  - id: customer_places_order
    source: customer
    target: order
    label: places
    direction: directed
  - id: order_contains_product
    source: order
    target: product
    label: contains
    direction: directed
  - id: order_is_paid_by
    source: order
    target: payment
    label: is paid by
    direction: directed
  - id: payment_refund
    source: payment
    target: refund
    label: may create
    direction: directed
    description: A successful reversal may produce this outcome.
  - id: customer_reviews_order
    source: customer
    target: order
    label: reviews
    direction: directed
  - id: product_substitutes_product
    source: product
    target: product
    label: may substitute for
    direction: directed
  - id: a_to_b
    source: a
    target: b
    label: connects
    direction: directed
  - id: b_to_c
    source: b
    target: c
    label: connects
    direction: directed
  - id: c_to_a
    source: c
    target: a
    label: connects
    direction: directed
  - id: customer_knows_customer
    source: customer
    target: customer
    label: knows
    direction: undirected
```

### Database example

```text
title "Commerce persistence"
description "Selected commerce and audit tables; omissions are not absence claims."
schema commerce "commerce"
schema audit "audit"

table users "users" schema commerce {
  column user_id "id" uuid not-null
  column email "email" varchar(255) not-null
  column created_at "created at" timestamp not-null default "CURRENT_TIMESTAMP"
  primary-key users_pk user_id
  unique users_email_uq email
  index users_created_ix created_at
}
table orders "orders" schema commerce {
  column order_id "id" uuid not-null
  column buyer_id "buyer id" uuid not-null
  column region_code "region" varchar(8) not-null
  column order_number "number" varchar(32) not-null
  column refunded_at "refunded at" timestamp nullable
  primary-key orders_pk order_id
  unique orders_region_number_uq region_code, order_number
}
table payments "payments" schema commerce {
  column payment_id "id" uuid not-null
  column order_region "order region" varchar(8) not-null
  column order_number "order number" varchar(32) not-null
  column amount "amount" decimal(10,2) not-null
  primary-key payments_pk payment_id
  index payments_amount_ix amount
}
table order_lines "order lines" schema commerce {
  column line_no "line number" integer not-null
  column line_order_id "order id" uuid not-null
  column product_code "product code" varchar(32) not-null
  primary-key order_lines_pk line_no, line_order_id
}
table invoices "invoices" schema audit {
  column invoice_id "id" uuid not-null
  primary-key invoices_pk invoice_id
}
table users_archive "users" schema audit {
  column archive_user_id "id" uuid not-null
  primary-key users_archive_pk archive_user_id
}
table invoice_archive "invoice archive" schema audit {
  column archive_id "id" uuid not-null
  column previous_invoice "previous invoice" uuid nullable
  primary-key invoice_archive_pk archive_id
}

foreign-key payments_order payments_order_fk payments.order_region, payments.order_number -> orders.region_code, orders.order_number
foreign-key order_lines_order order_lines_order_fk order_lines.line_order_id -> orders.order_id
foreign-key invoice_archive_previous invoice_archive_previous_fk invoice_archive.previous_invoice -> invoice_archive.archive_id
```

### YAML equivalent

```yaml
kind: database
title: Commerce persistence
description: Selected commerce and audit tables; omissions are not absence claims.
schemas:
  - id: commerce
    name: commerce
  - id: audit
    name: audit
tables:
  - id: users
    schema: commerce
    name: users
    columns:
      - {id: user_id, name: id, type: uuid, nullable: false}
      - {id: email, name: email, type: varchar(255), nullable: false}
      - id: created_at
        name: created at
        type: timestamp
        nullable: false
        default: CURRENT_TIMESTAMP
    primaryKey: {id: users_pk, columns: [user_id]}
    uniqueConstraints:
      - {id: users_email_uq, columns: [email]}
    indexes:
      - {id: users_created_ix, columns: [created_at]}
  - id: orders
    schema: commerce
    name: orders
    columns:
      - {id: order_id, name: id, type: uuid, nullable: false}
      - {id: buyer_id, name: buyer id, type: uuid, nullable: false}
      - {id: region_code, name: region, type: varchar(8), nullable: false}
      - {id: order_number, name: number, type: varchar(32), nullable: false}
      - {id: refunded_at, name: refunded at, type: timestamp, nullable: true}
    primaryKey: {id: orders_pk, columns: [order_id]}
    uniqueConstraints:
      - {id: orders_region_number_uq, columns: [region_code, order_number]}
  - id: payments
    schema: commerce
    name: payments
    columns:
      - {id: payment_id, name: id, type: uuid, nullable: false}
      - {id: order_region, name: order region, type: varchar(8), nullable: false}
      - {id: order_number, name: order number, type: varchar(32), nullable: false}
      - {id: amount, name: amount, type: decimal(10,2), nullable: false}
    primaryKey: {id: payments_pk, columns: [payment_id]}
    indexes:
      - {id: payments_amount_ix, columns: [amount]}
  - id: order_lines
    schema: commerce
    name: order_lines
    columns:
      - {id: line_no, name: line number, type: integer, nullable: false}
      - {id: line_order_id, name: order id, type: uuid, nullable: false}
      - {id: product_code, name: product code, type: varchar(32), nullable: false}
    primaryKey: {id: order_lines_pk, columns: [line_no, line_order_id]}
  - id: invoices
    schema: audit
    name: invoices
    columns:
      - {id: invoice_id, name: id, type: uuid, nullable: false}
    primaryKey: {id: invoices_pk, columns: [invoice_id]}
  - id: users_archive
    schema: audit
    name: users
    columns:
      - {id: archive_user_id, name: id, type: uuid, nullable: false}
    primaryKey: {id: users_archive_pk, columns: [archive_user_id]}
  - id: invoice_archive
    schema: audit
    name: invoice archive
    columns:
      - {id: archive_id, name: id, type: uuid, nullable: false}
      - {id: previous_invoice, name: previous invoice, type: uuid, nullable: true}
    primaryKey: {id: invoice_archive_pk, columns: [archive_id]}
foreignKeys:
  - {id: payments_order, sourceTable: payments, sourceColumns: [order_region, order_number], targetTable: orders, targetColumns: [region_code, order_number]}
  - {id: order_lines_order, sourceTable: order_lines, sourceColumns: [line_order_id], targetTable: orders, targetColumns: [order_id]}
  - {id: invoice_archive_previous, sourceTable: invoice_archive, sourceColumns: [previous_invoice], targetTable: invoice_archive, targetColumns: [archive_id]}
```

The same fixture family also includes invalid Conceptual unknown endpoint; Database missing table and missing column; same display table name in separate schemas (`commerce.users` and `audit.users`); nullable FK; composite keys; associative table (`order_lines`); rename/endpoint edits below. Invalid fixtures are negative validator inputs, not accepted model states.

### Fixture operations and expected diagnostics

| Fixture | Input / edit | Expected semantic outcome |
|---|---|---|
| Conceptual unknown endpoint | `relation bad customer -> ghost "references"` | ERROR unknown target `ghost`; semantic model invalid |
| Concept rename | `concept customer "Customer"` → `concept customer "Account Holder"` | ModifyConcept(customer), not remove/add |
| Relationship label edit | `payment_refund` label `may create` → `can create` | ModifyRelationship(payment_refund) |
| Relationship endpoint edit | `payment_refund` target `refund` → `archived_order`, keep ID | ModifyRelationship(payment_refund) |
| Isolated concept | `archived_order` with no relation | ALLOWED; no absence claim |
| Database missing table | FK target `ghost.id` | ERROR unresolved target table |
| Database missing column | FK source `payments.no_such_column` | ERROR unresolved source column |
| Composite FK | two source and two target columns | Valid only at equal arity and existing columns; target tuple must be declared unique |
| Nullable FK | nullable `previous_invoice` to unique/PK target | Valid; minimum participation remains optional |
| Self-FK | `invoice_archive.previous_invoice -> invoice_archive.archive_id` | ALLOWED |
| Table rename | table ID `orders`, name `orders` → `customer_orders` | ModifyTable(orders) |
| Column rename | column ID `buyer_id`, display `buyer id` → `customer_id`, display `customer id` | ModifyColumn(buyer_id); without explicit ID, remove/add |
| Type edit | `decimal(10,2)` → `decimal(12,2)` | ModifyColumn(type), exact opaque text |
| FK endpoint edit | keep `payments_order`, change target mapping | ModifyForeignKey(payments_order) |
| Junction | `order_lines` with two identifying dimensions and FKs | Table plus independent FK facts; no inferred business cardinality |

## Source-format evaluation

Scores use 1 (poor) to 5 (strong), followed by the evidence-based reason. Scores are a comparison aid, not an arithmetic winner.

| Criterion | Dedicated DSL | Structured YAML |
|---|---:|---:|
| Human readability | 4 — domain declarations read directly | 4 — explicit structure, more punctuation |
| Human authoring | 4 — concise references and local edits | 3 — indentation and repeated keys |
| Local edit ergonomics | 5 — one declaration/line block per fact | 3 — edit usually touches nested list structure |
| Git diff quality | 5 — stable declaration-local hunks | 3 — good with stable ordering; indentation/wrapping adds noise |
| Merge-conflict behavior | 4 — independent declarations usually separate lines | 3 — independent list entries can still conflict at list boundaries |
| Stable identity visibility | 5 — IDs are part of declaration heads | 4 — IDs explicit but separated from entity headers |
| AI generation reliability | 4 — narrow grammar, but custom syntax must be learned | 5 — common schema and familiar structure |
| AI local-edit reliability | 5 — target by stable declaration ID | 4 — target list item by ID, risk reformatting neighboring YAML |
| MCP suitability | 5 — exact source ranges and targeted operations | 4 — structured object editing is natural, comments/order round-trip uncertain |
| Parser complexity | 3 — custom lexer/parser and grammar diagnostics | 4 — mature syntax model, but schema validation and source positions still needed |
| Diagnostic precision | 5 — declaration/source ranges designed into parser | 3 — parser libraries vary in source-mark retention |
| Forward compatibility | 4 — explicit grammar evolution needed | 4 — schema/version rules still needed |
| Comments/documentation | 4 — local comments plus explicit description blocks | 4 — comments supported but common serializers discard them |
| Escaping/multiline text | 4 — requires deliberate string/block syntax | 5 — standard scalar/block forms |
| Deterministic formatting | 5 — grammar can preserve declarations without reserialization | 3 — serializers often normalize quotes/order/comments |
| Round-trip potential | 5 — concrete syntax tree can preserve untouched text | 2 — generic YAML parse/stringify commonly loses comments and formatting |
| Semantic noise | 5 — concise typed declarations | 3 — keys, indentation and repeated structure |
| Incomplete knowledge | 5 — omission naturally remains omission; no default completeness claim | 5 — same if schema avoids defaults |
| Conceptual suitability | 5 — concepts/relations are first-class statements | 4 — representable, but relation mappings are verbose |
| Database suitability | 4 — concise typed constraints; grammar is more involved | 5 — nested schema objects map naturally |

### Git-diff and deterministic editing experiment

The experiment compares representative single-declaration transformations on the examples above; it is a source-shape evaluation, not a benchmark or implementation claim.

| Change | DSL textual result | YAML textual result | Finding |
|---|---|---|---|
| Rename concept | `concept customer "Customer"` → same line with `"Account Holder"` | only `name` scalar changes in customer object | Both local; DSL ID/name proximity makes continuity obvious. |
| Add concept + relationship label “may create” | append concept and one relation line/block | append list entries | Both patchable; DSL uses fewer structural tokens. |
| Change relationship label | one label token/string changes | one `label` scalar changes | Equivalent semantic signal. |
| Change relationship endpoint | one endpoint ID changes; relation ID fixed | one `target` scalar changes | Stable relation ID is visible in both. |
| Reorder unrelated declarations | source lines move; semantic model unchanged | list items move; semantic model unchanged | Both create textual churn if reordered; no canonical sorting/formatter is justified. |
| Rename table | table declaration name changes, ID stays | only `name` property changes | Local in both; identity/name separation visible. |
| Rename column | explicit column ID fixed; display/name changes | ID fixed, `name` changes | Without explicit ID, fallback `(tableId,name)` means remove/add. |
| `varchar(100)` → `varchar(255)` | one type token changes | one type scalar changes | Exact and low-noise in both. |
| Add FK | one independent FK declaration | one `foreignKeys` list object | DSL line is compact; YAML is more verbose but clearly structured. |
| Change FK endpoint | one endpoint reference changes with FK ID fixed | one target table/column field changes | Same semantic clarity. |
| Add index | one index declaration | one index object under table | DSL keeps constraint adjacent to table declarations; YAML nesting helps ownership. |
| Reorder unrelated tables | declaration blocks move | table list objects move | Both show reorder as source diff, but semantic diff must ignore it. |

Semantic signal/noise is good in both when IDs are stable. DSL has less syntactic noise and declaration-local parser positions. YAML has lower syntax-learning cost but ordinary parse/stringify harms comment/order round-trip and makes safe minimal patches dependent on a comment-preserving editor. Do not canonical-sort either form: authored order is useful in review, not semantic. An eventual DSL concrete-syntax-preserving parser can keep untouched source stable; formatter is not an implementation prerequisite.

### AI/MCP authoring assessment

For `Add a Refund concept and connect Payment to Refund with "may create"`, an agent can append a `concept refund ...` plus a relation with a chosen stable ID; endpoint names are exact local IDs and validation reports unresolved references. For `Add nullable refunded_at timestamp to payments and index it`, an agent edits the payments block and adds one typed index declaration. In YAML the same operations are easy to express as objects, but a generic serializer may rewrite comments, quote styles, and neighboring indentation. Targeted MCP edits should eventually name local IDs and operate through the parser/model with source ranges, not ask the agent to replace a whole file. IDs remove ambiguity for relationship label edits and explicit-ID columns; name fallback is intentionally less capable. No MCP tool is added here.

DSL costs: a custom parser and authored grammar. It wins because the repository already treats line-oriented source as the artifact boundary, needs precise source diagnostics, and values localized source edits over generic interchange. YAML remains useful for generated input/import if future evidence calls for it, but it should map to the same semantic model rather than become a second canonical source.

## Spike disposition and future seams

| Prototype artifact | Disposition |
|---|---|
| This document's side-by-side examples and edit matrix | KEEP as decision evidence |
| Any executable parser/model prototype | None created; the syntax decision did not require production-shaped code |
| Candidate YAML schema/serializer | DELETE / do not create absent a concrete interchange requirement |
| Production parser/model | PROMOTE IN NEXT PHASE, separately for Conceptual and Database; do not register types in this spike |

Both future models can project to geometry-only input: Concept -> visual box, relationship -> visual edge; Table -> compound box, columns -> rows/ports, FK -> visual edge. Geometry, positions and route data stay in projection/layout. Future DDL and introspection importers target `DatabaseModel`, not SQL AST; source provenance, dialect and extraction boundary belong at importer/resource-analysis boundaries. Semantic diff relies on stable IDs. Conceptual source syntax is not a limit on future Mermaid/UML importers. Cross-artifact binding, public reader, Presentation, index, UI, proposal visuals, and MCP production operations are deferred to their implementation phases. No layout engine decision is made.

## Required decision table

| Area | Approved | Area | Approved |
|---|---|---|---|
| Conceptual semantic model | Dedicated concepts + relationships | Database semantic model | Schema-native database/tables/columns/constraints |
| Concept ID | Required stable local ID | Schema | Optional; implicit namespace allowed |
| Concept kind | Not mandatory; no V1 kind | Table ID | Required stable local ID |
| Relationship ID | Required stable local ID | Column ID | Optional; explicit for rename continuity, otherwise `(tableId,name)` |
| Relationship label | Required open authored text | Column type | Opaque authored string |
| Relationship direction | `directed` or `undirected`; directed default | Nullability | Required boolean for authored V1 column |
| Cross-artifact identity | Explicit evidence only, deferred | PK | V1 |
| Closed-world semantics | No | FK | V1, explicit mapped column lists and stable ID |
| Unique | SHOULD in V1 | Index | SHOULD in V1, distinct from unique |
| Default | Optional opaque expression | Cardinality | Only structurally proven bounds; otherwise unknown |
| Completeness | Defer; omissions remain unknown | Source format | Dedicated DSL recommendation |
| Conceptual type/extension | `conceptual` / `.concept` | Database type/extension | `database` / `.dbschema` |
| Canonical formatting | Not required initially | Manual layout | No; coordinates absent |
| Layout engine | Deferred until projections exist | Formatter | Not required initially |

## Blocking gate and mandatory answers

All 20 blocking questions are resolved by the Approved decisions table. No unresolved D02.1 blocker remains; implementation grammar details (quoting, multiline scalar syntax, identifier lexical grammar, exact diagnostic codes) belong to parser implementation and may be refined without changing these semantic decisions.

| # | YES/NO question | Answer |
|---:|---|---|
| 1 | Conceptual contract frozen enough to implement parser/model? | YES |
| 2 | Concept IDs explicit and stable? | YES |
| 3 | Concept names independent from IDs? | YES |
| 4 | Concept kinds mandatory in V1? | NO |
| 5 | Relationship IDs explicit and stable? | YES |
| 6 | Relationship labels use a closed platform enum? | NO |
| 7 | Relationship direction has explicit semantics? | YES |
| 8 | Conceptual absence means proven non-relationship? | NO |
| 9 | Database contract frozen enough to implement parser/model? | YES |
| 10 | Tables have explicit stable IDs? | YES |
| 11 | Table display names independent from IDs? | YES |
| 12 | Columns have a defined identity strategy? | YES |
| 13 | FKs have explicit stable IDs? | YES |
| 14 | FK semantics independent from rendered lines? | YES |
| 15 | Schema supported? | YES |
| 16 | Schema mandatory? | NO |
| 17 | Data types dialect-specific platform objects? | NO |
| 18 | PK is V1? | YES |
| 19 | FK is V1? | YES |
| 20 | Unique supported in V1? | YES |
| 21 | Index supported in V1? | YES |
| 22 | Default supported in V1? | YES |
| 23 | Triggers V1? | NO |
| 24 | Views V1? | NO |
| 25 | Cardinality inference limited to proven structural evidence? | YES |
| 26 | Database absence universally proves real-world absence? | NO |
| 27 | Source format evaluated using realistic examples? | YES |
| 28 | Git diff behavior evaluated? | YES |
| 29 | AI/MCP editing behavior evaluated? | YES |
| 30 | Syntax independent from semantic model? | YES |
| 31 | Visual coordinates absent from semantic contract? | YES |
| 32 | Generic GraphNode/GraphEdge became domain primitives? | NO |
| 33 | Layout engine selected prematurely? | NO |
| 34 | Future DDL import can target DatabaseModel? | YES |
| 35 | Future semantic diff can rely on stable identities? | YES |
| 36 | Future renderer can project both models to geometry? | YES |
| 37 | Cross-artifact identity remains explicit-only? | YES |
| 38 | Existing governance remains authoritative? | YES |
| 39 | Existing sharing authority remains authoritative? | YES |
| 40 | Production artifact implementation introduced prematurely? | NO |

### Deferred

- Exact production grammar, lexer/AST representation, escape syntax, formatter policy beyond “not required initially,” and diagnostic code inventory.
- Future optional Concept classification/relation lint vocabulary; cross-artifact identity registry and bindings.
- Database completeness/scope and importer provenance; dialect normalization and engine-specific type/constraint validation.
- Whether checks, generated columns, views/materialized views or trigger/routine modeling ever warrant dedicated artifact semantics.
- Analysis index representation, renderers, proposal semantic review, MCP operations, UI, layout engine and manual-layout persistence.

## Outcome

Production code changed: **NO**. Spike code retained: **NO**. The semantic contracts and source-format direction are ready for separate parser/model implementation phases. Existing architecture/governance authority is unchanged.
