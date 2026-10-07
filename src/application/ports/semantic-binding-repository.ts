import type { SemanticBinding } from "../../domain/workspace/semantic-binding";

export interface SemanticBindingScope {
  projectId: string;
  contextId: string | null;
}

export type SemanticBindingWrite = Omit<SemanticBinding, "revision">;

export interface SemanticBindingRepository {
  list(scope: SemanticBindingScope): Promise<SemanticBinding[]>;
  get(scope: SemanticBindingScope, id: string): Promise<SemanticBinding | null>;
  history(scope: SemanticBindingScope, id: string): Promise<SemanticBinding[]>;
  create(binding: SemanticBinding): Promise<SemanticBinding>;
  update(scope: SemanticBindingScope, binding: SemanticBinding, expectedRevision: number): Promise<SemanticBinding>;
  remove(scope: SemanticBindingScope, id: string, expectedRevision: number): Promise<SemanticBinding>;
  retire(scope: SemanticBindingScope, id: string, expectedRevision: number): Promise<SemanticBinding>;
}
