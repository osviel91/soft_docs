export interface Concept { id: string; name: string; description?: string }
export interface ConceptualRelationship {
  id: string;
  sourceConceptId: string;
  targetConceptId: string;
  label: string;
  direction: "directed" | "undirected";
  description?: string;
}
export interface ConceptualModel {
  title?: string;
  description?: string;
  concepts: Concept[];
  relationships: ConceptualRelationship[];
}
