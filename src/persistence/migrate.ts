/**
 * The migration runner (ADR-040).
 *
 * A migration is one SQL string applied inside one transaction together with
 * the row that records it, so the schema and its history can never disagree: a
 * failure leaves no partial schema and no entry. Running the migrations twice is
 * a no-op, which is what makes every process start with `migrate()` rather than
 * a documented manual step nobody performs.
 *
 * The runner splits the SQL on statement boundaries itself. A multi-statement
 * simple query cannot carry bind parameters, and the transaction wrapper needs
 * statements it can send individually.
 */
import type { SqlClient } from "./sql-client";
import { up as initialSchema } from "./migrations/0001-initial-schema";
import { up as agentCredentials } from "./migrations/0002-agent-credentials";
import { up as workspaceOperations } from "./migrations/0003-workspace-operations";
import { up as accountApproval } from "./migrations/0004-account-approval";
import { up as workspaces } from "./migrations/0005-workspaces";
import { up as localCredentials } from "./migrations/0006-local-credentials";
import { up as userIdentities } from "./migrations/0007-user-identities";
import { up as workspaceLifecycle } from "./migrations/0008-workspace-lifecycle";
import { up as resourceMetadata } from "./migrations/0009-resource-metadata";
import { up as resourceRevisions } from "./migrations/0010-resource-revisions";
import { up as changeProposals } from "./migrations/0011-change-proposals";
import { up as mergedProposals } from "./migrations/0012-merged-proposals";
import { up as mergeSchemaRepair } from "./migrations/0013-merge-schema-repair";
import { repairMergeSchema } from "./migrations/0013-merge-schema-repair";
import { up as mergedStatusConstraint } from "./migrations/0014-merged-status-constraint";
import { up as resourceRelationships } from "./migrations/0015-resource-relationships";
import { up as privateWorkContexts } from "./migrations/0016-private-work-contexts";
import { up as architecturalProposals } from "./migrations/0017-architectural-proposals";
import { up as proposalReviews } from "./migrations/0018-proposal-reviews";
import { up as authoritativeLifecycle } from "./migrations/0019-authoritative-lifecycle";
import { up as authoritativeBatches } from "./migrations/0020-authoritative-batches";
import { up as promotions } from "./migrations/0021-promotions";
import { up as explicitProposalOperations } from "./migrations/0022-explicit-proposal-operations";
import { up as governedProposalOperations } from "./migrations/0023-governed-proposal-operations";
import { up as proposalResourcePaths } from "./migrations/0024-proposal-resource-paths";
import { up as proposalLifecycle } from "./migrations/0025-proposal-lifecycle";
import { up as workspaceSelfReview } from "./migrations/0026-workspace-self-review";
import { up as workspaceInvitations } from "./migrations/0027-workspace-invitations";
import { up as projectShareGrants } from "./migrations/0028-project-share-grants";
import { up as conceptualDatabaseTypes } from "./migrations/0029-conceptual-database-resource-types";
import { up as preserveProjectsOnOwnerDelete } from "./migrations/0030-preserve-projects-on-owner-delete";
import { up as semanticBindings } from "./migrations/0031-semantic-bindings";
import { up as proposalSemanticBindings } from "./migrations/0032-proposal-semantic-bindings";
import { up as promotionSemanticBindings } from "./migrations/0033-promotion-semantic-bindings";

/** One migration: a stable name and the SQL that applies it. */
export interface Migration {
  /** Sort key and identity. Applied in ascending order, never reordered. */
  version: number;
  /** A short human name, recorded for diagnostics. */
  name: string;
  /** The statements to apply, in order. */
  sql: string;
}

/** Every migration the server knows, oldest first. */
export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: "initial-schema", sql: initialSchema },
  { version: 2, name: "agent-credentials", sql: agentCredentials },
  { version: 3, name: "workspace-operations", sql: workspaceOperations },
  { version: 4, name: "account-approval", sql: accountApproval },
  { version: 5, name: "workspaces", sql: workspaces },
  { version: 6, name: "local-credentials", sql: localCredentials },
  { version: 7, name: "user-identities", sql: userIdentities },
  { version: 8, name: "workspace-lifecycle", sql: workspaceLifecycle },
  { version: 9, name: "resource-metadata", sql: resourceMetadata },
  { version: 10, name: "resource-revisions", sql: resourceRevisions },
  { version: 11, name: "change-proposals", sql: changeProposals },
  { version: 12, name: "merged-proposals", sql: mergedProposals },
  { version: 13, name: "merge-schema-repair", sql: mergeSchemaRepair },
  { version: 14, name: "merged-status-constraint", sql: mergedStatusConstraint },
  { version: 15, name: "resource-relationships", sql: resourceRelationships },
  { version: 16, name: "private-work-contexts", sql: privateWorkContexts },
  { version: 17, name: "architectural-proposals", sql: architecturalProposals },
  { version: 18, name: "proposal-reviews", sql: proposalReviews },
  { version: 19, name: "authoritative-lifecycle", sql: authoritativeLifecycle },
  { version: 20, name: "authoritative-batches", sql: authoritativeBatches },
  { version: 21, name: "promotions", sql: promotions },
  { version: 22, name: "explicit-proposal-operations", sql: explicitProposalOperations },
  { version: 23, name: "governed-proposal-operations", sql: governedProposalOperations },
  { version: 24, name: "proposal-resource-paths", sql: proposalResourcePaths },
  { version: 25, name: "proposal-lifecycle", sql: proposalLifecycle },
  { version: 26, name: "workspace-self-review", sql: workspaceSelfReview },
  { version: 27, name: "workspace-invitations", sql: workspaceInvitations },
  { version: 28, name: "project-share-grants", sql: projectShareGrants },
  { version: 29, name: "conceptual-database-resource-types", sql: conceptualDatabaseTypes },
  { version: 30, name: "preserve-projects-on-owner-delete", sql: preserveProjectsOnOwnerDelete },
  { version: 31, name: "semantic-bindings", sql: semanticBindings },
  { version: 32, name: "proposal-semantic-bindings", sql: proposalSemanticBindings },
  { version: 33, name: "promotion-semantic-bindings", sql: promotionSemanticBindings },
];

/**
 * Split a migration into statements.
 *
 * Splitting on `;` is safe here because these migrations contain no function
 * bodies, no dollar-quoted strings and no semicolons inside literals — a
 * constraint the migration tests assert, so a future migration that breaks it
 * fails loudly rather than being applied halfway.
 */
export function splitStatements(sql: string): string[] {
  return sql
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement !== "");
}

/** The result of a migration run. */
export interface MigrationReport {
  /** The versions applied by this run, in order. Empty when already current. */
  applied: number[];
  /** The versions already present before this run. */
  present: number[];
}

/** Create the history table if this is a fresh database. */
async function ensureHistoryTable(client: SqlClient): Promise<void> {
  await client.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       version    integer PRIMARY KEY,
       name       text        NOT NULL,
       applied_at timestamptz NOT NULL DEFAULT now()
     )`,
  );
}

/** The versions already applied, in ascending order. */
async function appliedVersions(client: SqlClient): Promise<number[]> {
  const result = await client.query(
    "SELECT version FROM schema_migrations ORDER BY version ASC",
  );
  return result.rows.map((row) => Number(row.version));
}

/**
 * Apply every migration the database is missing.
 *
 * @param client - The database to migrate.
 * @param migrations - The migrations to apply; injectable so a test can prove
 *   the runner's ordering and idempotence without a second schema.
 */
export async function migrate(
  client: SqlClient,
  migrations: readonly Migration[] = MIGRATIONS,
): Promise<MigrationReport> {
  await ensureHistoryTable(client);
  const present = await appliedVersions(client);
  const known = new Set(present);
  const applied: number[] = [];

  const ordered = [...migrations].sort((a, b) => a.version - b.version);
  for (const migration of ordered) {
    if (known.has(migration.version)) continue;
    await client.transaction(async (tx) => {
      for (const statement of splitStatements(migration.sql)) {
        await tx.query(statement);
      }
      await tx.query(
        "INSERT INTO schema_migrations (version, name) VALUES ($1, $2)",
        [migration.version, migration.name],
      );
    });
    applied.push(migration.version);
  }

  // H20.2.1: repair merge columns even when a drifted database falsely records
  // the repair migration as applied.
  await repairMergeSchema(client);

  return { applied, present };
}
