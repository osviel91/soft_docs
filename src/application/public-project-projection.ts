import { analyzeResource } from "../domain/project/resource-analysis";
import {
  buildProjectIndex,
  type ResourceDescriptor,
} from "../domain/project/project-index";
import { validateProject } from "../domain/project/validate";
import { createEmptyMetadata, parseProjectMetadata, type ProjectMetadata } from "../domain/workspace/metadata";
import { resourceClassificationOf } from "../domain/workspace/resource-id";
import { normalizeResourceMetadata } from "../domain/workspace/resource-metadata";
import type { ResourceRelationship } from "../domain/workspace/resource-relationship";
import type { SemanticBinding } from "../domain/workspace/semantic-binding";

export interface PublicProjectSource {
  id: string;
  path: string;
  type: ResourceDescriptor["type"];
  revision: number;
  metadata?: { description?: string; tags?: string[] };
  content: string;
}

/** Build the public catalog only from the source files and manifest passed in. */
export function buildPublicProjectProjection(
  projectId: string,
  sources: PublicProjectSource[],
  manifestContent: string | null,
  relationships: ResourceRelationship[],
  semanticBindings: SemanticBinding[] = [],
) {
  let parsed: ProjectMetadata | null = null;
  if (manifestContent !== null) {
    try {
      parsed = parseProjectMetadata(JSON.parse(manifestContent));
    } catch {
      // Malformed metadata is not authoritative; source analysis can still proceed.
    }
  }
  const empty = createEmptyMetadata();
  const sourceIds = new Set(sources.map((source) => source.id));
  const visibleBindings = semanticBindings.filter((binding) => binding.status === "ACTIVE" && binding.provenance.contextId === undefined && sourceIds.has(binding.left.resourceId) && sourceIds.has(binding.right.resourceId));
  const analyses = sources.map((source) => {
    const classification = resourceClassificationOf(source.type);
    const descriptor: ResourceDescriptor = {
      id: source.id,
      projectId,
      path: source.path,
      type: source.type,
      title: source.path,
      ...classification,
    };
    return analyzeResource(descriptor, source.content);
  });
  const referencedMessageIds = new Set([
    ...analyses.flatMap((analysis) => analysis.semanticOccurrences.map((item) => item.messageRef)),
    ...analyses.flatMap((analysis) => analysis.eventFlowMessages.map((item) => item.messageRef)),
  ].filter((id): id is string => typeof id === "string"));
  const metadata: ProjectMetadata = {
    ...empty,
    resources: sources.map((source) => {
      const recorded = parsed?.resources.find((entry) => entry.id === source.id && entry.path === source.path && entry.type === source.type);
      return {
        id: source.id,
        path: source.path,
        type: source.type,
        ...(recorded?.title ? { title: recorded.title } : {}),
        ...(recorded?.tags ? { tags: recorded.tags } : {}),
        ...(source.metadata ? { metadata: normalizeResourceMetadata(source.metadata) } : {}),
      };
    }),
    relationships: relationships.filter((item) => sourceIds.has(item.sourceId) && sourceIds.has(item.targetId)),
    semanticMessages: (parsed?.semanticMessages ?? []).filter((message) => referencedMessageIds.has(message.id)),
  };
  const index = buildProjectIndex(projectId, analyses, metadata, (core) =>
    validateProject(core, analyses.flatMap((analysis) => analysis.diagnostics), metadata),
  );
  const messageIds = new Set(metadata.semanticMessages?.map((message) => message.id));
  const safeOccurrences = (index.semanticOccurrences ?? []).map((entry) => ({
    ...entry,
    ...(entry.messageRef && messageIds.has(entry.messageRef) ? {} : { messageRef: undefined }),
  }));
  const safeEventFlowMessages = (index.eventFlowMessages ?? []).map((entry) => ({
    ...entry,
    ...(entry.messageRef && messageIds.has(entry.messageRef) ? {} : { messageRef: undefined }),
  }));
  const safeCausality = (index.eventFlowCausality ?? []).map((entry) => ({
    ...entry,
    view: {
      ...entry.view,
      messages: entry.view.messages.map((message) => ({
        ...message,
        ...(message.messageRef && messageIds.has(message.messageRef) ? {} : { messageRef: undefined }),
      })),
    },
  }));
  const { diagnostics: _diagnostics, ...catalog } = index;
  void _diagnostics;
  const folders = [...new Set(sources.flatMap(({ path }) => {
    const parts = path.split("/");
    return parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join("/"));
  }))].sort();
  return {
    folders,
    resources: sources.map((source) => ({
      id: source.id,
      path: source.path,
      type: source.type,
      revision: source.revision,
      title: catalog.resources.find((resource) => resource.id === source.id)?.title ?? source.path,
      ...(source.metadata?.description ? { description: source.metadata.description } : {}),
      ...(source.metadata?.tags ? { tags: source.metadata.tags } : {}),
      content: source.content,
    })),
    catalog: {
      ...catalog,
      relationships: metadata.relationships,
      semanticBindings: visibleBindings.map((binding) => ({
        ...binding,
        evidence: {
          ...binding.evidence,
          items: binding.evidence.items.map((item) => item.kind === "internal" && !sourceIds.has(item.resourceId)
            ? { kind: "unavailable" as const }
            : item),
        },
      })),
      semanticOccurrences: safeOccurrences,
      eventFlowMessages: safeEventFlowMessages,
      eventFlowCausality: safeCausality,
    },
  };
}
