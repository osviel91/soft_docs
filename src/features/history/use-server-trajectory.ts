import { useEffect, useState } from "react";
import type { ServerApiClient, ServerTrajectoryEntry } from "../../workspace/server/api-client";

export function useServerTrajectory(
  client: ServerApiClient,
  projectId: string | null,
  resourceId: string | null,
  contextId: string | null,
  enabled: boolean,
): { entries: ServerTrajectoryEntry[]; isLoading: boolean } {
  const key = JSON.stringify([projectId, contextId, resourceId]);
  const [result, setResult] = useState<{ key: string; entries: ServerTrajectoryEntry[]; isLoading: boolean }>({ key: "", entries: [], isLoading: false });
  useEffect(() => {
    if (!enabled || !projectId) {
      setResult({ key, entries: [], isLoading: false });
      return;
    }
    let active = true;
    setResult({ key, entries: [], isLoading: true });
    void (resourceId
      ? client.getResourceTrajectory(projectId, resourceId, {}, contextId)
      : client.getProjectTrajectory(projectId, {}, contextId)
    )
      .then((result) => {
        if (active) setResult({ key, entries: result.entries, isLoading: false });
      })
      .catch(() => {
        if (active) setResult({ key, entries: [], isLoading: false });
      });
    return () => {
      active = false;
    };
  }, [client, enabled, projectId, resourceId, contextId, key]);
  return result.key === key ? { entries: result.entries, isLoading: result.isLoading } : { entries: [], isLoading: enabled && projectId !== null };
}
