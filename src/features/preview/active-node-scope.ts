export interface ActiveNodeScope {
  workspaceMode: string;
  projectId: string | null;
  contextId: string | null;
  resourceId: string | null;
  representation: string;
}

export function activeNodeScopeKey(scope: ActiveNodeScope): string {
  return JSON.stringify([scope.workspaceMode, scope.projectId, scope.contextId, scope.resourceId, scope.representation]);
}
