import { useEffect, useState } from "react";
import type {
  ServerApiClient,
  ServerChangeProposal,
  ServerChangeProposalDiff,
  ServerResource,
} from "../../workspace/server/api-client";
import type { MergeAnalysis } from "../../domain/diff/merge-analysis";

export interface ProjectProposalEntry {
  proposal: ServerChangeProposal;
  resource: ServerResource;
  diff: ServerChangeProposalDiff | null;
  analysis: MergeAnalysis | null;
}

export async function loadProjectProposals(
  client: ServerApiClient,
  projectId: string,
  details = false,
): Promise<ProjectProposalEntry[]> {
  const resources = await client.listResources(projectId);
  const grouped = await Promise.all(
    resources.map(async (resource) =>
      (await client.listChangeProposals(projectId, resource.id)).map(
        (proposal) => ({
          proposal,
          resource,
          diff: null,
          analysis: null,
        }),
      ),
    ),
  );
  const entries = grouped
    .flat()
    .sort(
      (a, b) =>
        Date.parse(b.proposal.updatedAt) - Date.parse(a.proposal.updatedAt),
    );
  if (!details) return entries;
  return Promise.all(
    entries.map(async (entry) => {
      try {
        const [diff, analysis] = await Promise.all([
          client.getChangeProposalDiff(entry.proposal.id),
          client.getChangeProposalMergeAnalysis(entry.proposal.id),
        ]);
        return { ...entry, diff, analysis };
      } catch {
        return entry;
      }
    }),
  );
}

export function useProjectProposalCount(
  client: ServerApiClient,
  projectId: string | null,
  refreshKey = 0,
): number {
  const [count, setCount] = useState(0);
  useEffect(() => {
    if (!projectId) {
      setCount(0);
      return;
    }
    let active = true;
    void loadProjectProposals(client, projectId)
      .then((entries) => {
        if (active)
          setCount(
            entries.filter(({ proposal }) => proposal.status === "open").length,
          );
      })
      .catch(() => {
        if (active) setCount(0);
      });
    return () => {
      active = false;
    };
  }, [client, projectId, refreshKey]);
  return count;
}

export function useResourceProposalCount(
  client: ServerApiClient,
  projectId: string | null,
  resourcePath: string | null,
  contextId: string | null,
  refreshKey = 0,
): number | null {
  const key = projectId && resourcePath && contextId === null
    ? `${projectId}:${resourcePath}`
    : null;
  const [result, setResult] = useState<{ key: string; count: number } | null>(null);
  useEffect(() => {
    if (!projectId || !resourcePath || contextId !== null) return;
    let active = true;
    void client.listResources(projectId).then(async (resources) => {
      if (!active) return;
      const matches = resources.filter((item) => item.path === resourcePath);
      if (matches.length !== 1) return;
      const resource = matches[0];
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(resource.id)) return;
      const items = await client.listChangeProposals(projectId, resource.id);
      if (active) setResult({ key: `${projectId}:${resourcePath}`, count: items.filter((item) => item.status === "open").length });
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [client, projectId, resourcePath, contextId, refreshKey]);
  return key && result?.key === key ? result.count : null;
}

export function useProjectResourceProposalCounts(
  client: ServerApiClient,
  projectId: string | null,
  refreshKey = 0,
): Record<string, number> {
  const [counts, setCounts] = useState<Record<string, number>>({});
  useEffect(() => {
    if (!projectId) {
      setCounts({});
      return;
    }
    let active = true;
    void loadProjectProposals(client, projectId)
      .then((entries) => {
        if (!active) return;
        const next: Record<string, number> = {};
        for (const { proposal } of entries) {
          if (proposal.status === "open")
            next[proposal.resourceId] = (next[proposal.resourceId] ?? 0) + 1;
        }
        setCounts(next);
      })
      .catch(() => {
        if (active) setCounts({});
      });
    return () => {
      active = false;
    };
  }, [client, projectId, refreshKey]);
  return counts;
}
