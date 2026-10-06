import type { ConceptualModel } from "./model";
import { estimateTextWidth, wrapText } from "../../layout/text";
import type { GeometryConnection, GeometryInput } from "../../layout/geometry-input";

export interface ConceptualVisualItem {
  visualId: string;
  semanticConceptId: string;
  name: string;
  nameLines: string[];
  descriptionLines: string[];
  description?: string;
  requiredWidth: number;
  requiredHeight: number;
}

export interface ConceptualVisualConnection {
  visualId: string;
  semanticRelationshipId: string;
  sourceVisualId: string;
  targetVisualId: string;
  direction: "directed" | "undirected";
  label: string;
}

export interface ConceptualVisualProjection {
  items: ConceptualVisualItem[];
  connections: ConceptualVisualConnection[];
  visualIdByConceptId: Record<string, string>;
  visualIdByRelationshipId: Record<string, string>;
  geometry: GeometryInput;
}

const itemId = (id: string) => `concept-item:${encodeURIComponent(id)}`;
const connectionId = (id: string) => `concept-connection:${encodeURIComponent(id)}`;
const EDGE_LABEL_WIDTH = 220;
const EDGE_LABEL_PADDING = 12;

/** Project concepts to measured boxes and relationships to individually identified connections. */
export function projectConceptual(model: ConceptualModel): ConceptualVisualProjection {
  const items = model.concepts.map(concept => {
    const visualId = itemId(concept.id);
    const nameLines = wrapText(concept.name, 224, 16);
    const descriptionLines = concept.description ? wrapText(concept.description, 224, 13) : [];
    const requiredWidth = Math.min(280, Math.max(140, ...nameLines.map(line => estimateTextWidth(line, 16) + 32), ...(descriptionLines.length ? [Math.max(...descriptionLines.map(line => estimateTextWidth(line, 13))) + 24] : [])));
    return {
      visualId,
      semanticConceptId: concept.id,
      name: concept.name,
      nameLines,
      descriptionLines,
      ...(concept.description === undefined ? {} : { description: concept.description }),
      requiredWidth,
      requiredHeight: 30 + nameLines.length * 19 + descriptionLines.length * 18,
    };
  });
  const connections = model.relationships.map(relationship => ({
    visualId: connectionId(relationship.id),
    semanticRelationshipId: relationship.id,
    sourceVisualId: itemId(relationship.sourceConceptId),
    targetVisualId: itemId(relationship.targetConceptId),
    direction: relationship.direction,
    label: relationship.label,
  }));
  const visualIdByConceptId = Object.fromEntries(items.map(item => [item.semanticConceptId, item.visualId]));
  const visualIdByRelationshipId = Object.fromEntries(connections.map(connection => [connection.semanticRelationshipId, connection.visualId]));
  const geometryConnections: GeometryConnection[] = connections.map(connection => {
    const labelLines = wrapText(connection.label, EDGE_LABEL_WIDTH, 12);
    return {
      id: connection.visualId,
      source: { itemId: connection.sourceVisualId },
      target: { itemId: connection.targetVisualId },
      label: {
        text: labelLines.join("\n"),
        requiredWidth: Math.max(24, ...labelLines.map(line => estimateTextWidth(line, 12))) + EDGE_LABEL_PADDING,
        requiredHeight: labelLines.length * 18 + EDGE_LABEL_PADDING,
      },
    };
  });
  return {
    items,
    connections,
    visualIdByConceptId,
    visualIdByRelationshipId,
    geometry: {
      items: items.map(item => ({ id: item.visualId, requiredWidth: item.requiredWidth, requiredHeight: item.requiredHeight })),
      connections: geometryConnections,
    },
  };
}
