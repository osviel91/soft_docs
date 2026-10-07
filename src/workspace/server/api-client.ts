/**
 * The browser's API client: the one place that knows what the server's HTTP
 * surface looks like.
 *
 * Nothing above this module — no React component, no workspace repository —
 * builds a URL, serializes a body or reads a status code. A caller asks for a
 * resource and gets either a typed value or one of the errors in
 * {@link ./api-errors}. That indirection is what lets the editor run unchanged
 * against IndexedDB and against the server: only the adapter below the
 * `WorkspaceRepository` seam knows there is a network at all.
 *
 * Two deliberate decisions:
 *
 * - **Authentication is ambient.** Every request is sent with
 *   `credentials: "same-origin"`, so the HttpOnly session cookie travels with it
 *   and no token ever exists in JavaScript. There is no `Authorization` header to
 *   leak, because the browser holds the credential and only the browser can read
 *   it back.
 * - **A transport failure is not a verdict.** A rejected `fetch` (offline, DNS,
 *   connection reset) becomes a {@link NetworkError}, never an {@link ApiError}:
 *   nothing was refused, so nothing may be reported as refused, and the caller
 *   must keep the user's content and offer a retry.
 */
import { apiErrorFromResponse, NetworkError } from "./api-errors";
import type { ResourceMetadata } from "../../domain/workspace/resource-metadata";
import type { MergeAnalysis } from "../../domain/diff/merge-analysis";
import type { ResourceAuthorship } from "../../domain/workspace/resource-revision";
import type { ResourceDiff } from "../../domain/diff/resource-diff";
import type { ResourceTrajectoryKind } from "../../domain/workspace/resource-trajectory";
import type { ResourceRelationship } from "../../domain/workspace/resource-relationship";
import type { SemanticMessageIdentity } from "../../domain/workspace/metadata";
import type { SemanticBinding, EntityAnchor, BindingEvidence } from "../../domain/workspace/semantic-binding";

/** The signed-in person, as `GET /api/me` reports them. */
export interface AuthenticatedUser {
  id: string;
  displayName: string;
  email: string | null;
  authType: string;
  scopes: readonly string[];
  accountStatus?: "PENDING" | "ACTIVE" | "SUSPENDED";
  platformAdmin?: boolean;
}

export interface ServerAdminUser {
  id: string;
  displayName: string;
  email: string | null;
  status: "PENDING" | "ACTIVE" | "SUSPENDED";
  platformAdmin: boolean;
  createdAt?: string;
}

/** A project listing, as the API renders it. */
export interface ServerProject {
  id: string;
  workspaceId: string;
  name: string;
  slug: string;
  ownerId: string;
  role: string;
  resourceCount: number;
  createdAt: string;
  updatedAt: string;
}

export type ServerWorkspaceRole = "ADMIN" | "EDITOR" | "VIEWER";

export interface ServerWorkspace {
  id: string;
  ownerId: string;
  name: string;
  isDefault: boolean;
  allowAuthorSelfReview: boolean;
  role: ServerWorkspaceRole;
  createdAt: string;
  updatedAt: string;
}

export interface ServerWorkspaceMember {
  workspaceId: string;
  userId: string;
  displayName: string;
  email: string | null;
  role: ServerWorkspaceRole;
  createdAt: string;
}

export interface WorkspaceInvitationPreview {
  workspaceName: string;
  role: ServerWorkspaceRole;
  inviterName: string;
  expiresAt: string;
}

export interface ServerWorkspaceInvitation extends WorkspaceInvitationPreview {
  id: string;
  workspaceId: string;
  state: "ACTIVE" | "ACCEPTED" | "REVOKED" | "EXPIRED";
  createdAt: string;
}

/** The type a server resource can carry. */
export type ServerResourceType =
  "sequence-diagram" | "event-flow" | "markdown-document" | "conceptual" | "database";

/** A resource's identity and concurrency state, as the API renders it. */
export interface ServerResource {
  id: string;
  projectId: string;
  contextId?: string;
  path: string;
  type: ServerResourceType;
  revision: number;
  metadata?: ResourceMetadata;
}

/** What the caller may do in a project, for rendering affordances. */
export interface ServerProjectAccess {
  projectId: string;
  role: string;
  permissions: readonly string[];
}

export interface ProjectShareRecord {
  id: string;
  projectId: string;
  createdByUserId: string;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  revokedByUserId: string | null;
  resourceIds: string[];
  state: "ACTIVE" | "REVOKED" | "EXPIRED";
}

export interface PublicSharedProject {
  project: { name: string };
  folders: string[];
  resources: Array<{ id: string; path: string; type: ServerResourceType; revision: number; title: string; description?: string; tags?: string[]; content: string }>;
  catalog: Record<string, unknown>;
}

export interface ServerPrivateWorkContext {
  id: string;
  projectId: string;
  ownerUserId: string;
  name: string;
  description?: string;
  lifecycle: "active" | "archived";
  createdAt: string;
  updatedAt: string;
  capabilities?: Record<string, ServerCapabilityDecision>;
}

export interface ServerCapabilityDecision {
  capability: string;
  allowed: boolean;
  reason?: string;
  requiredPermission?: string;
  requiredRole?: string;
  requiredWorkspaceRole?: "ADMIN";
  state?: string;
}

export type ServerProjectCapabilities = Record<string, ServerCapabilityDecision>;

export interface ServerArchitecturalProposal {
  id: string;
  projectId: string;
  authorUserId: string;
  sourcePrivateContextId?: string;
  title: string;
  description?: string;
  status: "open" | "withdrawn" | "superseded";
  supersedesProposalId?: string | null;
  withdrawnAt?: string | null;
  withdrawnBy?: string | null;
  withdrawalReason?: string | null;
  supersededAt?: string | null;
  baseSharedRevision: string;
  baseSharedResourceRevisions: Record<string, number>;
  currentSharedRevision?: string;
  staleBase?: boolean;
  reviewStatus?: "none" | "approved" | "changes-requested" | "mixed";
  approvals?: number;
  changesRequested?: number;
  createdAt: string;
  submittedAt: string;
  resources: Array<{ sourceResourceId: string; path: string; type: ServerResourceType; sourceRevision: number; content: string; operation?: "CREATE" | "UPDATE" | "RETIRE"; baseResourceId?: string; baseRevision?: number }>;
  semanticMessages: Array<{ id: string; name: string; kind: "event" | "command" }>;
  semanticBindings?: Array<{ operation: "ADD" | "UPDATE" | "REMOVE"; binding: SemanticBinding; baseBinding?: SemanticBinding; bindingId?: string }>;
  relationships: ResourceRelationship[];
  capabilities?: Record<string, ServerCapabilityDecision>;
  lifecycle?: { state: "OPEN" | "CHANGES_REQUESTED" | "APPROVED" | "PROMOTING" | "PROMOTED" | "WITHDRAWN" | "SUPERSEDED"; promotionStatus?: "COMMITTED_COMPLETION_PENDING" | "COMPLETED" };
  promotion?: { id: string; status: "COMMITTED_COMPLETION_PENDING" | "COMPLETED"; createdAt: string; completedAt?: string; resultingSharedRevision: string };
  supersedes?: { id: string; title: string };
  supersededBy?: { id: string; title: string };
  revisionContextId?: string;
}

export interface ServerArchitecturalProposalDiffResource {
  path: string;
  type: ServerResourceType;
  operation: "ADDED" | "MODIFIED" | "DELETED";
  baseRevision?: number;
  basePath?: string;
  baseContent: string;
  proposedContent: string;
  changed: boolean;
  metadata: { changed: boolean; changes: Array<{ kind: "added" | "removed" | "modified"; field: "description" | "tag"; identity: string; oldValue?: string; newValue?: string }> };
  content: { available: boolean; changes: Array<{ kind: "added" | "removed" | "modified"; entity: string; identity: string; details?: Record<string, unknown> }>; diagnostics: unknown[]; truncated: boolean; totalChanges: number; returnedChanges: number };
  source: { changed: boolean; hunks: Array<{ oldStart: number; newStart: number; oldLines: string[]; newLines: string[] }>; truncated: boolean; totalHunks: number; returnedHunks: number };
}
export interface ServerArchitecturalProposalDiff {
  proposalId: string; baseSharedRevision: string; currentSharedRevision: string; staleBase: boolean;
  resources: ServerArchitecturalProposalDiffResource[];
  relationships: Array<{ operation: "ADDED" | "MODIFIED" | "DELETED"; label: string }>;
  semanticIdentities: Array<{ operation: "ADDED" | "MODIFIED" | "DELETED"; label: string }>;
  semanticBindings?: Array<{ operation: "ADDED" | "MODIFIED" | "DELETED"; bindingId: string; endpointDelta: { before: { left: EntityAnchor; right: EntityAnchor } | null; after: { left: EntityAnchor; right: EntityAnchor } | null }; relationDelta: { before: string | null; after: string | null }; evidenceDelta: { before: BindingEvidence | null; after: BindingEvidence | null } }>;
  impact: { resourcesAdded: number; resourcesModified: number; resourcesDeleted: number; relationshipsChanged: number; semanticIdentitiesChanged: number; semanticBindingsChanged?: number };
}

export interface ServerProposalReview {
  id: string;
  proposalId: string;
  reviewerUserId: string;
  reviewerDisplayName?: string;
  decision: "APPROVE" | "REQUEST_CHANGES";
  summary?: string;
  createdAt: string;
  updatedAt: string;
  proposalBaseRevision: string;
  observedSharedRevision: string;
}
export interface ServerProposalReviewSummary {
  status: "none" | "approved" | "changes-requested" | "mixed";
  approvals: number;
  changesRequested: number;
  reviews: ServerProposalReview[];
}

export interface ServerPromotionPreview {
  eligible: boolean;
  reviewStatus: "none" | "approved" | "changes-requested" | "mixed";
  staleBase: boolean;
  blockers: Array<{ code: string; message: string; resourceId?: string; expectedRevision?: number; currentRevision?: number }>;
  creates: Array<{ path: string; operation: "CREATE"; resultingRevision?: number }>;
  updates: Array<{ path: string; operation: "UPDATE"; basePath?: string; resultingRevision?: number }>;
  retires: Array<{ path: string; operation: "RETIRE" }>;
  semanticIdentityAdditions?: string[];
  semanticIdentityReuses?: string[];
  semanticChanges?: Array<{ operation: "ADD" | "UPDATE" | "RETIRE"; message: { id: string; name: string; kind: "event" | "command" } }>;
  relationships?: Array<{ operation: "ADD" | "UPDATE" | "REMOVE"; relationship: ResourceRelationship; baseFingerprint?: string }>;
}

/** An agent identity, as `/api/agents` renders it. */
export interface ServerAgent {
  id: string;
  name: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
  disabledAt: string | null;
  disabled: boolean;
  credentialCount?: number;
  activeCredentialCount?: number;
}

/** A credential's metadata, as `/api/agents/:id/credentials` renders it. */
export interface ServerCredential {
  id: string;
  agentId: string;
  name: string;
  prefix: string;
  scopes: readonly string[];
  allowedProjectIds: readonly string[] | null;
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  status: "active" | "revoked" | "expired" | "disabled";
}

/** A newly created credential: its metadata plus the one-time plaintext. */
export interface CreatedServerCredential {
  /** The full `sdm_pat_…` value. The caller must show it and then forget it. */
  secret: string;
  credential: ServerCredential;
}

/** The agent list together with the scope vocabulary the server offers. */
export interface ServerAgentList {
  agents: ServerAgent[];
  scopes: string[];
  defaultScopes: string[];
}

/** A credential list together with the scope vocabulary the server offers. */
export interface ServerCredentialList {
  credentials: ServerCredential[];
  scopes: string[];
  defaultScopes: string[];
}

/** The `fetch` shape this client uses. Injectable so a test needs no network. */
export type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

function queryString(options: { limit?: number; cursor?: number }): string {
  const params = new URLSearchParams();
  if (options.limit !== undefined) params.set("limit", String(options.limit));
  if (options.cursor !== undefined) params.set("cursor", String(options.cursor));
  const value = params.toString();
  return value === "" ? "" : `?${value}`;
}

/** Options for {@link ServerApiClient}. */
export interface ServerApiClientOptions {
  /**
   * The API's origin. Defaults to the page's own origin, which is how the
   * deployment runs (one host, the API behind `/api` and `/auth`).
   */
  baseUrl?: string;
  /** Where requests are sent from. Defaults to the global `fetch`. */
  fetch?: FetchLike;
}

/** A resource that may or may not exist, as `GET` reports it. */
export interface ServerResourceRead {
  resource: ServerResource;
  content: string;
}

export interface ServerChangeProposal {
  id: string;
  resourceId: string;
  baseRevision: number;
  proposedContent: string;
  proposedMetadata?: ResourceMetadata;
  title: string;
  description?: string;
  author: ResourceAuthorship;
  createdAt: string;
  updatedAt: string;
  status: "draft" | "open" | "closed" | "merged";
  version: number;
  mergeActor?: ResourceAuthorship;
  mergedAt?: string;
  mergedRevision?: number;
}

export interface ServerChangeProposalDiff extends ResourceDiff {
  proposalId: string;
  resourceId: string;
  baseRevision: number;
  currentRevision: number;
  stale: boolean;
  type: "sequence-diagram" | "event-flow" | "markdown-document" | "conceptual" | "database";
  baseContent: string;
  proposedContent: string;
  baseMetadata?: ResourceMetadata;
  proposedMetadata?: ResourceMetadata;
}

export interface ServerTrajectoryEntry {
  id: string;
  projectId?: string;
  resourceId: string;
  resourcePath?: string;
  resourceType?: ServerResourceType;
  kind: ResourceTrajectoryKind;
  occurredAt: string;
  actor: ResourceAuthorship | null;
  previousRevision?: number;
  baseRevision?: number;
  resultingRevision?: number;
  proposalId?: string;
  proposalTitle?: string;
  proposedBy?: ResourceAuthorship;
  mergedBy?: ResourceAuthorship;
}

/**
 * A thin, typed wrapper over the server's HTTP API.
 *
 * Every method either resolves with the server's answer (already narrowed out of
 * its envelope) or throws a typed error. It never returns a `Response`, so no
 * caller has to remember which statuses are "fine".
 */
export class ServerApiClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;

  constructor(options: ServerApiClientOptions = {}) {
    // A trailing slash would double up when joined with `/api/...`.
    this.baseUrl = (options.baseUrl ?? "").replace(/\/+$/, "");
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
  }

  /** The URL of the sign-in route, for a full-page navigation. */
  loginUrl(returnTo?: string): string {
    const query =
      returnTo === undefined || returnTo === ""
        ? ""
        : `?returnTo=${encodeURIComponent(returnTo)}`;
    return `${this.baseUrl}/auth/login${query}`;
  }

  /** The current user, or `null` when nobody is signed in. */
  async me(): Promise<AuthenticatedUser | null> {
    const body = await this.request<{ user: AuthenticatedUser | null }>(
      "GET",
      "/api/me",
    );
    return body.user ?? null;
  }

  async registerLocalAccount(input: {
    email: string;
    password: string;
    displayName?: string;
  }): Promise<{ status: "PENDING"; message: string }> {
    return this.request<{ status: "PENDING"; message: string }>(
      "POST",
      "/auth/register",
      input,
    );
  }

  async loginLocal(input: {
    email: string;
    password: string;
  }): Promise<{ status: "authenticated" }> {
    return this.request<{ status: "authenticated" }>(
      "POST",
      "/auth/local-login",
      input,
    );
  }

  async listAdminUsers(): Promise<ServerAdminUser[]> {
    const body = await this.request<{ users: ServerAdminUser[] }>(
      "GET",
      "/api/admin/users",
    );
    return body.users ?? [];
  }

  async setUserStatus(
    userId: string,
    status: ServerAdminUser["status"],
  ): Promise<ServerAdminUser> {
    const body = await this.request<{ user: ServerAdminUser }>(
      "PATCH",
      `/api/admin/users/${encodeURIComponent(userId)}`,
      { status },
    );
    return body.user;
  }

  async listWorkspaces(): Promise<ServerWorkspace[]> {
    const body = await this.request<{ workspaces: ServerWorkspace[] }>(
      "GET",
      "/api/workspaces",
    );
    return body.workspaces ?? [];
  }

  async setWorkspaceAuthorSelfReview(workspaceId: string, allowed: boolean): Promise<void> {
    await this.request<unknown>(
      "PATCH",
      `/api/admin/workspaces/${encodeURIComponent(workspaceId)}/self-review`,
      { allowed },
    );
  }

  async createWorkspace(name: string): Promise<ServerWorkspace> {
    const body = await this.request<{ workspace: ServerWorkspace }>(
      "POST",
      "/api/workspaces",
      { name },
    );
    return body.workspace;
  }

  async renameWorkspace(
    workspaceId: string,
    name: string,
  ): Promise<ServerWorkspace> {
    const body = await this.request<{ workspace: ServerWorkspace }>(
      "PATCH",
      `/api/workspaces/${encodeURIComponent(workspaceId)}`,
      { name },
    );
    return body.workspace;
  }

  async deleteWorkspace(workspaceId: string): Promise<void> {
    await this.request<unknown>(
      "DELETE",
      `/api/workspaces/${encodeURIComponent(workspaceId)}`,
    );
  }

  async listWorkspaceMembers(
    workspaceId: string,
  ): Promise<ServerWorkspaceMember[]> {
    const body = await this.request<{ members: ServerWorkspaceMember[] }>(
      "GET",
      `/api/workspaces/${encodeURIComponent(workspaceId)}/members`,
    );
    return body.members ?? [];
  }

  async setWorkspaceMemberRole(
    workspaceId: string,
    userId: string,
    role: ServerWorkspaceRole,
  ): Promise<ServerWorkspaceMember> {
    const body = await this.request<{ member: ServerWorkspaceMember }>(
      "PUT",
      `/api/workspaces/${encodeURIComponent(workspaceId)}/members/${encodeURIComponent(userId)}`,
      { role },
    );
    return body.member;
  }

  async removeWorkspaceMember(
    workspaceId: string,
    userId: string,
  ): Promise<void> {
    await this.request<unknown>(
      "DELETE",
      `/api/workspaces/${encodeURIComponent(workspaceId)}/members/${encodeURIComponent(userId)}`,
    );
  }

  async createWorkspaceInvitation(workspaceId: string, role: ServerWorkspaceRole): Promise<{ token: string; invitation: ServerWorkspaceInvitation }> {
    return this.request("POST", `/api/workspaces/${encodeURIComponent(workspaceId)}/invitations`, { role });
  }

  async listWorkspaceInvitations(workspaceId: string): Promise<ServerWorkspaceInvitation[]> {
    const body = await this.request<{ invitations: ServerWorkspaceInvitation[] }>("GET", `/api/workspaces/${encodeURIComponent(workspaceId)}/invitations`);
    return body.invitations ?? [];
  }

  async revokeWorkspaceInvitation(workspaceId: string, invitationId: string): Promise<void> {
    await this.request("DELETE", `/api/workspaces/${encodeURIComponent(workspaceId)}/invitations/${encodeURIComponent(invitationId)}`);
  }

  async inspectWorkspaceInvitation(token: string): Promise<WorkspaceInvitationPreview> {
    return this.request("POST", "/api/invitations/inspect", { token });
  }

  async acceptWorkspaceInvitation(token: string): Promise<{ workspaceId: string; role: ServerWorkspaceRole }> {
    return this.request("POST", "/api/invitations/accept", { token });
  }

  /** Every project the caller can access in one workspace. */
  async listProjects(workspaceId: string): Promise<ServerProject[]> {
    const body = await this.request<{ projects: ServerProject[] }>(
      "GET",
      `/api/projects?workspaceId=${encodeURIComponent(workspaceId)}`,
    );
    return body.projects ?? [];
  }

  /** Create a project and return its listing (the caller becomes its owner). */
  async createProject(
    name: string,
    workspaceId: string,
  ): Promise<ServerProject> {
    const body = await this.request<{ project: ServerProject }>(
      "POST",
      "/api/projects",
      { name, workspaceId },
    );
    return body.project;
  }

  async bootstrapProject(
    name: string,
    workspaceId: string,
    resources: Array<{ path: string; type: ServerResourceType; content: string }>,
  ): Promise<ServerProject> {
    const body = await this.request<{ project: ServerProject }>(
      "POST",
      "/api/projects/bootstrap",
      { name, workspaceId, resources },
    );
    return body.project;
  }

  /** Rename a project, or change its slug. */
  async updateProject(
    projectId: string,
    changes: { name?: string; slug?: string },
  ): Promise<ServerProject> {
    const body = await this.request<{ project: ServerProject }>(
      "PATCH",
      `/api/projects/${encodeURIComponent(projectId)}`,
      changes,
    );
    return body.project;
  }

  /** Delete a project and everything it holds. */
  async deleteProject(projectId: string): Promise<void> {
    await this.request<unknown>(
      "DELETE",
      `/api/projects/${encodeURIComponent(projectId)}`,
    );
  }

  /** What the caller may do in a project. Advisory: the server re-checks. */
  async access(projectId: string): Promise<ServerProjectAccess> {
    return this.request<ServerProjectAccess>(
      "GET",
      `/api/projects/${encodeURIComponent(projectId)}/access`,
    );
  }

  async capabilities(projectId: string): Promise<ServerProjectCapabilities> {
    const body = await this.request<{ capabilities: ServerProjectCapabilities }>(
      "GET",
      `/api/projects/${encodeURIComponent(projectId)}/capabilities`,
    );
    return body.capabilities;
  }

  async createProjectShare(projectId: string, resourceIds: string[]): Promise<{ token: string; grant: ProjectShareRecord }> {
    return this.request("POST", `/api/projects/${encodeURIComponent(projectId)}/shares`, { resourceIds });
  }

  async listProjectShares(projectId: string): Promise<ProjectShareRecord[]> {
    const body = await this.request<{ grants: ProjectShareRecord[] }>("GET", `/api/projects/${encodeURIComponent(projectId)}/shares`);
    return body.grants ?? [];
  }

  async revokeProjectShare(projectId: string, grantId: string): Promise<void> {
    await this.request("DELETE", `/api/projects/${encodeURIComponent(projectId)}/shares/${encodeURIComponent(grantId)}`);
  }

  async readPublicSharedProject(token: string): Promise<PublicSharedProject> {
    // Deliberately omit ambient session credentials: the bearer link alone defines this view.
    const response = await fetch(`/api/public/projects/shared/${encodeURIComponent(token)}`, { credentials: "omit", cache: "no-store", headers: { Accept: "application/json" } });
    if (response.status === 404) throw new Error("unavailable");
    if (!response.ok) throw new Error("network");
    return response.json() as Promise<PublicSharedProject>;
  }

  /** Every resource a project records. */
  async listResources(projectId: string, contextId?: string | null): Promise<ServerResource[]> {
    const query = contextId ? `?contextId=${encodeURIComponent(contextId)}` : "";
    const body = await this.request<{ resources: ServerResource[] }>(
      "GET",
      `/api/projects/${encodeURIComponent(projectId)}/resources${query}`,
    );
    return body.resources ?? [];
  }

  async listPrivateWorkContexts(projectId: string): Promise<ServerPrivateWorkContext[]> {
    const body = await this.request<{ contexts: ServerPrivateWorkContext[] }>("GET", `/api/projects/${encodeURIComponent(projectId)}/private-work`);
    return body.contexts ?? [];
  }

  async listArchitecturalProposals(projectId: string): Promise<ServerArchitecturalProposal[]> {
    const body = await this.request<{ proposals: ServerArchitecturalProposal[] }>("GET", `/api/projects/${encodeURIComponent(projectId)}/architectural-proposals`);
    return body.proposals ?? [];
  }

  async submitArchitecturalProposal(projectId: string, input: { sourcePrivateContextId: string; resourceIds: string[]; retireResourceIds?: string[]; resourceOperations?: Array<{ resourceId: string; operation: "CREATE" | "UPDATE"; baseResourceId?: string; path?: string; baseRevision?: number }>; semanticMessages?: Array<{ id: string; name: string; kind: "event" | "command"; operation?: "ADD" | "UPDATE" | "RETIRE"; baseName?: string; baseKind?: "event" | "command" }>; relationshipOperations?: Array<{ sourceId: string; targetId: string; kind: "complementary-view"; sourceRole?: "execution" | "causal" | "other"; targetRole?: "execution" | "causal" | "other"; operation?: "ADD" | "UPDATE" | "REMOVE"; baseFingerprint?: string }>; semanticBindings?: Array<{ bindingId: string; operation: "ADD"; sourceRevision: number } | { bindingId: string; operation: "UPDATE"; sourceRevision: number; expectedRevision: number; baseFingerprint: string } | { bindingId: string; operation: "REMOVE"; expectedRevision: number; baseFingerprint: string }>; title: string; description?: string }): Promise<ServerArchitecturalProposal> {
    const body = await this.request<{ proposal: ServerArchitecturalProposal }>("POST", `/api/projects/${encodeURIComponent(projectId)}/architectural-proposals`, input);
    return body.proposal;
  }
  async reviseArchitecturalProposal(projectId: string, proposalId: string, input: { sourcePrivateContextId: string; resourceIds: string[]; retireResourceIds?: string[]; semanticBindings?: Array<{ bindingId: string; operation: "ADD"; sourceRevision: number } | { bindingId: string; operation: "UPDATE"; sourceRevision: number; expectedRevision: number; baseFingerprint: string } | { bindingId: string; operation: "REMOVE"; expectedRevision: number; baseFingerprint: string }>; title: string; description?: string }): Promise<ServerArchitecturalProposal> {
    const body = await this.request<{ proposal: ServerArchitecturalProposal }>("POST", `/api/projects/${encodeURIComponent(projectId)}/architectural-proposals/${encodeURIComponent(proposalId)}/revise`, input);
    return body.proposal;
  }
  async withdrawArchitecturalProposal(projectId: string, proposalId: string, reason?: string): Promise<ServerArchitecturalProposal> {
    const body = await this.request<{ proposal: ServerArchitecturalProposal }>("POST", `/api/projects/${encodeURIComponent(projectId)}/architectural-proposals/${encodeURIComponent(proposalId)}/withdraw`, reason === undefined ? {} : { reason });
    return body.proposal;
  }

  async getArchitecturalProposal(projectId: string, proposalId: string): Promise<ServerArchitecturalProposal> {
    const body = await this.request<{ proposal: ServerArchitecturalProposal }>("GET", `/api/architectural-proposals/${encodeURIComponent(proposalId)}?projectId=${encodeURIComponent(projectId)}`);
    return body.proposal;
  }

  async getArchitecturalProposalReviews(projectId: string, proposalId: string): Promise<ServerProposalReviewSummary> {
    const body = await this.request<{ reviews: ServerProposalReviewSummary }>("GET", `/api/architectural-proposals/${encodeURIComponent(proposalId)}/reviews?projectId=${encodeURIComponent(projectId)}`);
    return body.reviews;
  }

  async getArchitecturalProposalDiff(projectId: string, proposalId: string): Promise<ServerArchitecturalProposalDiff> {
    const body = await this.request<{ diff: ServerArchitecturalProposalDiff }>("GET", `/api/architectural-proposals/${encodeURIComponent(proposalId)}/diff?projectId=${encodeURIComponent(projectId)}`);
    return body.diff;
  }

  async reviewArchitecturalProposal(projectId: string, proposalId: string, input: { decision: "APPROVE" | "REQUEST_CHANGES"; summary?: string }): Promise<ServerProposalReview> {
    const body = await this.request<{ review: ServerProposalReview }>("POST", `/api/architectural-proposals/${encodeURIComponent(proposalId)}/reviews?projectId=${encodeURIComponent(projectId)}`, input);
    return body.review;
  }

  async previewArchitecturalProposalPromotion(projectId: string, proposalId: string): Promise<ServerPromotionPreview> {
    const body = await this.request<{ promotion: ServerPromotionPreview }>("GET", `/api/architectural-proposals/${encodeURIComponent(proposalId)}/promotion?projectId=${encodeURIComponent(projectId)}`);
    return body.promotion;
  }

  async promoteArchitecturalProposal(projectId: string, proposalId: string): Promise<unknown> {
    const body = await this.request<{ promotion: unknown }>("POST", `/api/architectural-proposals/${encodeURIComponent(proposalId)}/promotion?projectId=${encodeURIComponent(projectId)}`, undefined, { "Idempotency-Key": `promotion:${proposalId}` });
    return body.promotion;
  }

  async createPrivateWorkContext(projectId: string, input: { name: string; description?: string }): Promise<ServerPrivateWorkContext> {
    const body = await this.request<{ context: ServerPrivateWorkContext }>("POST", `/api/projects/${encodeURIComponent(projectId)}/private-work`, input);
    return body.context;
  }

  async updatePrivateWorkContext(projectId: string, contextId: string, input: { name?: string; description?: string; lifecycle?: "active" | "archived" }): Promise<ServerPrivateWorkContext> {
    const body = await this.request<{ context: ServerPrivateWorkContext }>("PATCH", `/api/projects/${encodeURIComponent(projectId)}/private-work/${encodeURIComponent(contextId)}`, input);
    return body.context;
  }

  async deletePrivateWorkContext(projectId: string, contextId: string): Promise<void> {
    await this.request<unknown>("DELETE", `/api/projects/${encodeURIComponent(projectId)}/private-work/${encodeURIComponent(contextId)}`);
  }

  async listSemanticMessages(projectId: string, contextId?: string | null): Promise<SemanticMessageIdentity[]> {
    const query = contextId ? `?contextId=${encodeURIComponent(contextId)}` : "";
    const body = await this.request<{ messages: SemanticMessageIdentity[] }>("GET", `/api/projects/${encodeURIComponent(projectId)}/semantic-messages${query}`);
    return body.messages ?? [];
  }

  async createSemanticMessage(
    projectId: string,
    input: { name: string; kind: "event" | "command"; contextId?: string },
  ): Promise<{ message: SemanticMessageIdentity; manifestRevision: number }> {
    return this.request("POST", `/api/projects/${encodeURIComponent(projectId)}/semantic-messages`, input);
  }

  async updateSemanticMessages(
    projectId: string,
    messages: SemanticMessageIdentity[],
    expectedManifestRevision: number,
    contextId?: string,
  ): Promise<{ messages: SemanticMessageIdentity[]; manifestRevision: number }> {
    return this.request("PUT", `/api/projects/${encodeURIComponent(projectId)}/semantic-messages`, { messages, expectedManifestRevision, ...(contextId === undefined ? {} : { contextId }) });
  }

  async listResourceRelationships(
    projectId: string,
    contextId?: string | null,
  ): Promise<ResourceRelationship[]> {
    const query = contextId ? `?contextId=${encodeURIComponent(contextId)}` : "";
    const body = await this.request<{ relationships: ResourceRelationship[] }>(
      "GET",
      `/api/projects/${encodeURIComponent(projectId)}/relationships${query}`,
    );
    return body.relationships ?? [];
  }

  async listSemanticBindings(projectId: string, contextId?: string | null): Promise<SemanticBinding[]> {
    const query = contextId ? `?contextId=${encodeURIComponent(contextId)}` : "";
    const body = await this.request<{ bindings: SemanticBinding[] }>("GET", `/api/projects/${encodeURIComponent(projectId)}/semantic-bindings${query}`);
    return body.bindings ?? [];
  }

  async getSemanticBinding(projectId: string, bindingId: string, contextId?: string | null): Promise<SemanticBinding> {
    const query = contextId ? `?contextId=${encodeURIComponent(contextId)}` : "";
    const body = await this.request<{ binding: SemanticBinding }>("GET", `/api/projects/${encodeURIComponent(projectId)}/semantic-bindings/${encodeURIComponent(bindingId)}${query}`);
    return body.binding;
  }

  async createSemanticBinding(projectId: string, contextId: string, binding: Omit<SemanticBinding, "projectId" | "revision" | "status" | "provenance">): Promise<SemanticBinding> {
    const body = await this.request<{ binding: SemanticBinding }>("POST", `/api/projects/${encodeURIComponent(projectId)}/semantic-bindings`, { contextId, binding });
    return body.binding;
  }

  async updateSemanticBinding(projectId: string, contextId: string, binding: SemanticBinding, expectedRevision: number): Promise<SemanticBinding> {
    const body = await this.request<{ binding: SemanticBinding }>("PUT", `/api/projects/${encodeURIComponent(projectId)}/semantic-bindings/${encodeURIComponent(binding.id)}`, { contextId, binding, expectedRevision });
    return body.binding;
  }

  async removeSemanticBinding(projectId: string, contextId: string, bindingId: string, expectedRevision: number): Promise<SemanticBinding> {
    const query = new URLSearchParams({ contextId, expectedRevision: String(expectedRevision) });
    const body = await this.request<{ binding: SemanticBinding }>("DELETE", `/api/projects/${encodeURIComponent(projectId)}/semantic-bindings/${encodeURIComponent(bindingId)}?${query}`);
    return body.binding;
  }

  /** Read one resource's record and text. */
  async readResource(
    projectId: string,
    resourceId: string,
    contextId?: string | null,
  ): Promise<ServerResourceRead> {
    const query = contextId ? `?contextId=${encodeURIComponent(contextId)}` : "";
    return this.request<ServerResourceRead>(
      "GET",
      `/api/projects/${encodeURIComponent(projectId)}/resources/${encodeURIComponent(resourceId)}${query}`,
    );
  }

  async getProjectTrajectory(
    projectId: string,
    options: { limit?: number; cursor?: number } = {},
  ): Promise<{ entries: ServerTrajectoryEntry[]; nextCursor: number | null }> {
    return this.request("GET", `/api/projects/${encodeURIComponent(projectId)}/trajectory${queryString(options)}`);
  }

  async getResourceTrajectory(
    projectId: string,
    resourceId: string,
    options: { limit?: number; cursor?: number } = {},
  ): Promise<{ entries: ServerTrajectoryEntry[]; nextCursor: number | null }> {
    return this.request("GET", `/api/projects/${encodeURIComponent(projectId)}/resources/${encodeURIComponent(resourceId)}/trajectory${queryString(options)}`);
  }

  async listChangeProposals(
    projectId: string,
    resourceId: string,
  ): Promise<ServerChangeProposal[]> {
    const body = await this.request<{ proposals: ServerChangeProposal[] }>(
      "GET",
      `/api/projects/${encodeURIComponent(projectId)}/resources/${encodeURIComponent(resourceId)}/proposals`,
    );
    return body.proposals ?? [];
  }

  async getChangeProposal(id: string): Promise<ServerChangeProposal> {
    const body = await this.request<{ proposal: ServerChangeProposal }>(
      "GET",
      `/api/change-proposals/${encodeURIComponent(id)}`,
    );
    return body.proposal;
  }

  async getChangeProposalDiff(id: string): Promise<ServerChangeProposalDiff> {
    const body = await this.request<{ diff: ServerChangeProposalDiff }>(
      "GET",
      `/api/change-proposals/${encodeURIComponent(id)}/diff`,
    );
    return body.diff;
  }

  async getChangeProposalMergeAnalysis(id: string): Promise<MergeAnalysis> {
    const body = await this.request<{ analysis: MergeAnalysis }>(
      "GET",
      `/api/change-proposals/${encodeURIComponent(id)}/merge-analysis`,
    );
    return body.analysis;
  }

  /** Create a resource at a path, refusing one that is already taken. */
  async createResource(
    projectId: string,
    input: {
      path: string;
      type: ServerResourceType;
      content: string;
      metadata?: ResourceMetadata;
      contextId?: string | null;
    },
  ): Promise<ServerResource> {
    const body = await this.request<{ resource: ServerResource }>(
      "POST",
      `/api/projects/${encodeURIComponent(projectId)}/resources`,
      input,
    );
    return body.resource;
  }

  /**
   * Replace a resource's content, refusing a stale `expectedRevision`.
   *
   * The revision is required by the server, and required here too: a write
   * without one is an instruction to overwrite whatever is there.
   */
  async updateResource(
    projectId: string,
    resourceId: string,
    input: {
      content: string;
      expectedRevision: number;
      metadata?: ResourceMetadata;
      contextId?: string | null;
    },
  ): Promise<ServerResource> {
    const body = await this.request<{ resource: ServerResource }>(
      "PUT",
      `/api/projects/${encodeURIComponent(projectId)}/resources/${encodeURIComponent(resourceId)}`,
      input,
    );
    return body.resource;
  }

  /** Move a resource to another path, keeping its id. */
  async moveResource(
    projectId: string,
    resourceId: string,
    input: { path: string; expectedRevision: number; contextId?: string | null },
  ): Promise<ServerResource> {
    const body = await this.request<{ resource: ServerResource }>(
      "POST",
      `/api/projects/${encodeURIComponent(projectId)}/resources/${encodeURIComponent(resourceId)}/move`,
      input,
    );
    return body.resource;
  }

  /** Delete a resource. */
  async deleteResource(projectId: string, resourceId: string, contextId?: string | null): Promise<void> {
    const query = contextId ? `?contextId=${encodeURIComponent(contextId)}` : "";
    await this.request<unknown>(
      "DELETE",
      `/api/projects/${encodeURIComponent(projectId)}/resources/${encodeURIComponent(resourceId)}${query}`,
    );
  }

  /** Revoke the session server-side and clear the cookie. */
  async logout(): Promise<void> {
    await this.request<unknown>("POST", "/auth/logout");
  }

  /** The caller's agents, with the scope vocabulary the server offers. */
  async listAgents(): Promise<ServerAgentList> {
    const body = await this.request<ServerAgentList>("GET", "/api/agents");
    return {
      agents: body.agents ?? [],
      scopes: body.scopes ?? [],
      defaultScopes: body.defaultScopes ?? [],
    };
  }

  /** Create an agent identity. */
  async createAgent(input: {
    name: string;
    description?: string | null;
  }): Promise<ServerAgent> {
    const body = await this.request<{ agent: ServerAgent }>(
      "POST",
      "/api/agents",
      input,
    );
    return body.agent;
  }

  /** Rename an agent, or change its description. */
  async renameAgent(
    agentId: string,
    changes: { name?: string; description?: string | null },
  ): Promise<ServerAgent> {
    const body = await this.request<{ agent: ServerAgent }>(
      "PATCH",
      `/api/agents/${encodeURIComponent(agentId)}`,
      changes,
    );
    return body.agent;
  }

  /** Disable an agent, invalidating every one of its credentials at once. */
  async disableAgent(agentId: string): Promise<ServerAgent> {
    const body = await this.request<{ agent: ServerAgent }>(
      "DELETE",
      `/api/agents/${encodeURIComponent(agentId)}`,
    );
    return body.agent;
  }

  /** Re-enable a disabled agent. */
  async enableAgent(agentId: string): Promise<ServerAgent> {
    const body = await this.request<{ agent: ServerAgent }>(
      "POST",
      `/api/agents/${encodeURIComponent(agentId)}/enable`,
    );
    return body.agent;
  }

  /** Every credential of an agent, with the offered scope vocabulary. */
  async listCredentials(agentId: string): Promise<ServerCredentialList> {
    const body = await this.request<ServerCredentialList>(
      "GET",
      `/api/agents/${encodeURIComponent(agentId)}/credentials`,
    );
    return {
      credentials: body.credentials ?? [],
      scopes: body.scopes ?? [],
      defaultScopes: body.defaultScopes ?? [],
    };
  }

  /**
   * Create a credential and return its one-time plaintext.
   *
   * The secret is in the return value and nowhere else: it is the caller's job
   * to show it, and this class never stores, logs or caches it.
   */
  async createCredential(
    agentId: string,
    input: {
      name: string;
      scopes: readonly string[];
      expiresAt?: string | null;
      allowedProjectIds?: readonly string[] | null;
    },
  ): Promise<CreatedServerCredential> {
    return this.request<CreatedServerCredential>(
      "POST",
      `/api/agents/${encodeURIComponent(agentId)}/credentials`,
      input,
    );
  }

  /** Rotate a credential: mint a replacement and revoke the old one. */
  async rotateCredential(
    agentId: string,
    credentialId: string,
  ): Promise<CreatedServerCredential & { replacedCredentialId: string }> {
    return this.request<
      CreatedServerCredential & { replacedCredentialId: string }
    >(
      "POST",
      `/api/agents/${encodeURIComponent(agentId)}/credentials/${encodeURIComponent(credentialId)}/rotate`,
    );
  }

  /** Revoke a credential. It stops authenticating immediately. */
  async revokeCredential(agentId: string, credentialId: string): Promise<void> {
    await this.request<unknown>(
      "DELETE",
      `/api/agents/${encodeURIComponent(agentId)}/credentials/${encodeURIComponent(credentialId)}`,
    );
  }

  /**
   * Send one request and unwrap its JSON envelope.
   *
   * @throws {ApiError} when the server refused the request.
   * @throws {NetworkError} when no answer arrived at all.
   */
  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    extraHeaders?: Record<string, string>,
  ): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        cache: "no-store",
        // The session is a cookie, and the cookie is HttpOnly: the browser
        // attaches it, JavaScript never sees it.
        credentials: "same-origin",
        headers: {
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...extraHeaders,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      throw new NetworkError(
        "The server could not be reached. Check your connection and try again.",
        error,
      );
    }

    if (!response.ok) {
      throw apiErrorFromResponse(response.status, await readJson(response));
    }

    // 204 and an empty body are both legal answers for a mutation that carries
    // nothing back; a caller asking for a value would fail loudly on `undefined`
    // rather than silently reading a shape that was never sent.
    if (response.status === 204) return undefined as T;
    const parsed = await readJson(response);
    return parsed as T;
  }
}

/** Read a response body as JSON, tolerating an empty or malformed one. */
async function readJson(response: Response): Promise<unknown> {
  const text = await response.text().catch(() => "");
  if (text.trim() === "") return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
