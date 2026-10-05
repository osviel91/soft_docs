# D02.2 — Conceptual and Database source

**Status:** production source/model/validation support. Conceptual and Database rendering, semantic diff, Share, and Presentation are implemented through artifact-specific renderers.

Source is authoritative. Parsing produces syntax records, constructs a separate semantic model, and validates it. Declaration order is retained but does not define identity. Both formats use UTF-8 text, `#` line comments, and zero-based half-open line ranges in diagnostics. Quoted strings support `\\`, `\"`, `\n`, `\r`, and `\t`; other escaped characters yield that character. IDs use `[a-z][a-z0-9_-]*` (ASCII, case-sensitive). Names, labels, descriptions, types, and defaults are authored text; Unicode is retained.

## Conceptual (`conceptual`, `.concept`)

```text
title "Commerce concepts"
description "Structural facts; not execution or causality."
concept customer "Customer" description "A person or organization."
concept order "Order"
relation places customer -> order "places orders"
relation relates customer -- order "related to"
```

Grammar (one declaration per line):

```text
document      := (title | description | concept | relation | comment | blank)*
title         := `title` STRING
description   := `description` STRING
concept       := `concept` ID STRING [`description` STRING]
relation      := `relation` ID ID (`->` | `--`) ID STRING [`description` STRING]
```

`->` constructs a directed relationship; `--` constructs undirected. Relationship IDs and concept IDs are independent, explicit, stable and resource-local. A display-name edit retains identity. Relationship labels are required open text; they do not imply topology or causality. Repeated endpoints are allowed as parallel facts; cycles, self-relations and isolated concepts are valid. Unknown endpoints and duplicate IDs are errors. Omitted relationships mean undocumented, not false. Descriptions are semantic strings (including escaped `\n` when needed); comments are discarded.

## Database (`database`, `.dbschema`)

```text
title "Commerce storage"
schema commerce "commerce"
table orders commerce "orders"
column orders order_id "id" {uuid} not-null
column orders - "amount" {decimal(10,2)} not-null default {0}
column orders - "note" {text} nullable description "Optional note"
primary-key orders_pk orders (id, amount)
unique orders_amount orders (amount, id)
unique orders_id orders (id)
index orders_amount_index orders (amount, id)
table audit - "audit records"
column audit audit_id "id" {uuid} not-null
primary-key audit_pk audit (id)
foreign-key audit_order audit (id) -> orders (id)
```

Grammar (one declaration per line; columns and keys follow their table):

```text
title        := `title` STRING
description  := `description` STRING
schema       := `schema` ID STRING
table        := `table` ID (SCHEMA_ID | `-`) STRING
column       := `column` TABLE_ID (COLUMN_ID | `-`) STRING `{` OPAQUE_TYPE `}` (`nullable` | `not-null`)
                [`default` `{` OPAQUE_DEFAULT `}`] [`description` STRING]
primary-key  := `primary-key` ID TABLE_ID `(` COLUMN (`,` COLUMN)* `)`
unique       := `unique` ID TABLE_ID `(` COLUMN (`,` COLUMN)* `)`
index        := `index` ID TABLE_ID `(` COLUMN (`,` COLUMN)* `)`
foreign-key  := `foreign-key` ID TABLE_ID `(` COLUMN (`,` COLUMN)* `)` `->`
                TABLE_ID `(` COLUMN (`,` COLUMN)* `)`
```

Braced types/defaults preserve opaque text verbatim (including spaces, punctuation, nested braces and SQL-like syntax); quote/comment escapes do not interpret them. Examples include `{varchar(255)}`, `{timestamp with time zone}`, `{now()}`, `{'pending'}`, and `{ARRAY[]::text[]}`. Nullability is mandatory and explicit. A table's ID is independent of schema/name. A column's explicit ID provides rename continuity; `-` means identity is `(table ID, exact column name)`. Schema declarations are optional; `-` means no schema is documented and is not silently `public`.

PK, unique and index column lists are ordered semantic references. PK references must resolve and PK columns must be not-null. FK IDs are explicit and stable; mappings are ordered and source/target arity and references must resolve. Target mappings must match a declared PK or unique key. Self-FKs are allowed. Types and defaults are not interpreted; engine-specific compatibility is not checked. No cardinality is asserted by this phase. Omitted schema/table/column/constraint facts mean undocumented here, not absent in a real database. Schema and table declarations may be referenced by IDs; tables must precede their columns and local keys, while FK targets may be declared later.

Both types retain authoritative `.concept`/`.dbschema` source and the generic create/read/update/validation, persistence, MY WORK and proposal-governance lifecycle. Database rendering consumes `DatabaseVisualProjection` and positioned geometry; it does not parse source or reconstruct constraints. Tables render as schema-qualified compound rows in authored column order. PK/FK/nullability/type are compact row notation; defaults, descriptions, uniqueness and indexes remain inspectable as accessible row/table details. FK arrows run source/referencing to target/referenced row ports. A composite FK routes through its first ordered port pair for legibility while its complete ordered mapping is retained in accessible relationship details; it remains one constraint. Self and parallel FKs retain distinct route identities. No cardinality is inferred. Selection highlights navigation context only; it is not semantic impact. Stable table and FK IDs determine diff identity; explicit column IDs preserve rename continuity, while columns without IDs use `(table ID, exact name)`. Source reorder and geometry never create semantic changes. Active SHARED Database resources use the existing public projection and Presentation authority; MY WORK and proposals remain excluded from Share. Cross-artifact bindings remain unsupported, and Database facts do not contribute Sequence or Event Flow semantics.
