import type { ApplicationContext } from "./context";
import type { ProjectCatalog } from "./project-catalog";
import { invalid } from "./errors";
import { discoverSemanticCandidates, type SemanticCandidate } from "../domain/project/semantic-candidate-discovery";
import { analyzeResource } from "../domain/project/resource-analysis";
import { buildProjectIndex } from "../domain/project/project-index";
import { createEmptyMetadata } from "../domain/workspace/metadata";
import type { EntityKind } from "../domain/workspace/semantic-binding";

const POLICY_VERSION = "semantic-candidates-v1";
const LEFT_ENTITY_KINDS: EntityKind[] = ["concept", "conceptual-relationship"];
const RIGHT_ENTITY_KINDS: EntityKind[] = ["table", "foreign-key", "column"];

export interface DiscoverSemanticCandidatesInput {
  projectId: string;
  contextId?: string;
  leftEntityKind?: EntityKind;
  rightEntityKind?: EntityKind;
  limit?: number;
  cursor?: string;
}

export interface DiscoveredSemanticCandidate extends SemanticCandidate {
  leftPath: string;
  rightPath: string;
}

export function createDiscoverSemanticCandidatesUseCase(catalog: ProjectCatalog) {
  return async (context: ApplicationContext, input: DiscoverSemanticCandidatesInput) => {
    const pageSize = input.limit ?? 50;
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 200) throw invalid("limit must be an integer from 1 to 200.");
    if (input.contextId !== undefined && !input.contextId.trim()) throw invalid("contextId cannot be empty.");
    if (input.leftEntityKind !== undefined && !LEFT_ENTITY_KINDS.includes(input.leftEntityKind)) throw invalid("leftEntityKind must be a Conceptual entity kind.");
    if (input.rightEntityKind !== undefined && !RIGHT_ENTITY_KINDS.includes(input.rightEntityKind)) throw invalid("rightEntityKind must be a Database entity kind.");

    const resources = input.contextId
      ? await catalog.listEffectiveResources(context, input.projectId, input.contextId)
      : await catalog.listResources(context, input.projectId);
    const analyses = [];
    for (const resource of resources) {
      const { content } = await catalog.readResource(context, input.projectId, resource.id, resource.contextId ?? null);
      analyses.push(analyzeResource({ id: resource.id, projectId: input.projectId, path: resource.path, type: resource.type, title: resource.path }, content));
    }
    const metadata = createEmptyMetadata();
    metadata.resources = resources.map(({ id, path, type }) => ({ id, path, type }));
    const index = buildProjectIndex(input.projectId, analyses, metadata, () => []);
    const bindings = await catalog.listSemanticBindings(context, input.projectId, input.contextId ?? null);
    const paths = new Map(resources.map((resource) => [resource.id, resource.path]));
    const filtered = discoverSemanticCandidates(index, bindings, POLICY_VERSION)
      .filter((candidate) => input.leftEntityKind === undefined || candidate.left.entityKind === input.leftEntityKind)
      .filter((candidate) => input.rightEntityKind === undefined || candidate.right.entityKind === input.rightEntityKind)
      .map((candidate): DiscoveredSemanticCandidate => ({
        ...candidate,
        leftPath: paths.get(candidate.left.resourceId) ?? "",
        rightPath: paths.get(candidate.right.resourceId) ?? "",
      }));
    const cursorIndex = input.cursor === undefined ? -1 : filtered.findIndex((candidate) => candidate.id === input.cursor);
    if (input.cursor !== undefined && cursorIndex < 0) throw invalid("The discovery cursor is not valid for this result set.", { field: "cursor" });
    const start = cursorIndex + 1;
    const candidates = filtered.slice(start, start + pageSize);
    const nextCursor = start + candidates.length < filtered.length ? candidates.at(-1)?.id : undefined;
    return {
      status: "unconfirmed" as const,
      notice: "Candidates are suggestions only; they are not bindings or evidence.",
      nextAction: "Inspect exact anchors and source evidence; use get_semantic_candidate, then assess in owned MY WORK if appropriate.",
      candidates,
      ...(nextCursor === undefined ? {} : { nextCursor }),
      context: input.contextId === undefined ? "SHARED" as const : "SHARED+MY_WORK" as const,
      policyVersion: POLICY_VERSION,
      total: filtered.length,
    };
  };
}
