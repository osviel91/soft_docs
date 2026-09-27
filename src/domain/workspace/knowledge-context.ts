/** The server-side architectural context a resource belongs to. */
export type KnowledgeContext = SharedContext | PrivateWorkContext;

export type KnowledgeContextKind = KnowledgeContext["kind"] | "local";

export interface AnalysisProvenance {
  kind: KnowledgeContextKind;
  id: string;
  label?: string;
}

export function analysisProvenanceLabel(provenance: AnalysisProvenance): string {
  if (provenance.kind === "shared") return "SHARED";
  if (provenance.kind === "local") return "LOCAL";
  return `MY WORK · ${provenance.label ?? provenance.id}`;
}

export interface SharedContext {
  kind: "shared";
  id: string;
  projectId: string;
}

export interface PrivateWorkContext {
  kind: "private-work";
  id: string;
  projectId: string;
  ownerUserId: string;
  name: string;
  description?: string;
  lifecycle: "active" | "archived";
  createdAt: Date;
  updatedAt: Date;
}

export const sharedContextId = (projectId: string): string => `shared:${projectId}`;
