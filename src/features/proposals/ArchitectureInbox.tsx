import { useEffect, useState } from "react";
import type { ServerApiClient, ServerProject, ServerProposalInbox, ServerWorkspace } from "../../workspace/server/api-client";
import PageHeader from "../ui/PageHeader";

const categoryLabels: Record<keyof ServerProposalInbox["counts"], string> = {
  PENDING_REVIEW: "Pending review",
  CHANGES_REQUESTED: "Changes requested",
  APPROVED_PENDING_PROMOTION: "Approved, promotion not evaluated",
  PROMOTION_COMPLETION_PENDING: "Promotion completing",
  PROMOTED: "Promoted",
  WITHDRAWN: "Withdrawn",
  SUPERSEDED: "Superseded",
};

function displayName(item: ServerProposalInbox["items"][number]): string {
  return item.author.displayName || item.author.userId;
}

export default function ArchitectureInbox({ client, onOpen }: { client: ServerApiClient; onOpen: (item: ServerProposalInbox["items"][number], returnTo: string) => void }) {
  const initialQuery = new URLSearchParams(window.location.search);
  const [workspaces, setWorkspaces] = useState<ServerWorkspace[]>([]);
  const [projects, setProjects] = useState<ServerProject[]>([]);
  const [workspaceId, setWorkspaceId] = useState(() => initialQuery.get("workspace") ?? "");
  const [projectId, setProjectId] = useState(() => initialQuery.get("projectFilter") ?? "");
  const [category, setCategory] = useState(() => initialQuery.get("attention") ?? "NEEDS_ATTENTION");
  const [search, setSearch] = useState(() => initialQuery.get("q") ?? "");
  const [submittedSearch, setSubmittedSearch] = useState(() => initialQuery.get("q") ?? "");
  const [cursors, setCursors] = useState<Array<string | undefined>>([undefined]);
  const [pageIndex, setPageIndex] = useState(0);
  const [result, setResult] = useState<ServerProposalInbox | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [unavailableNotice, setUnavailableNotice] = useState(() => initialQuery.get("unavailable") === "1");

  useEffect(() => {
    let active = true;
    void client.listWorkspaces().then(async (rows) => {
      const projectLists = await Promise.all(rows.map((workspace) => client.listProjects(workspace.id)));
      if (active) {
        setWorkspaces(rows);
        setProjects(projectLists.flat());
      }
    }).catch(() => { if (active) setError("Could not load accessible workspaces."); });
    return () => { active = false; };
  }, [client]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    void client.listProposalInbox({
      ...(workspaceId ? { workspaceId } : {}),
      ...(projectId ? { projectId } : {}),
      ...(category === "NEEDS_ATTENTION" ? { attentionCategory: ["PENDING_REVIEW", "CHANGES_REQUESTED", "APPROVED_PENDING_PROMOTION", "PROMOTION_COMPLETION_PENDING"] } : category ? { attentionCategory: [category] } : {}),
      ...(submittedSearch ? { search: submittedSearch } : {}),
      ...(cursors[pageIndex] ? { cursor: cursors[pageIndex] } : {}),
      limit: 50,
    }).then((value) => { if (active) setResult(value); }).catch((reason: unknown) => {
      if (active) setError(reason instanceof Error ? reason.message : "Could not load the Architecture Inbox.");
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [category, client, cursors, pageIndex, projectId, submittedSearch, workspaceId]);

  useEffect(() => {
    const params = new URLSearchParams();
    params.set("inbox", "proposals");
    if (workspaceId) params.set("workspace", workspaceId);
    if (projectId) params.set("projectFilter", projectId);
    if (category) params.set("attention", category);
    if (submittedSearch) params.set("q", submittedSearch);
    window.history.replaceState({}, "", `${window.location.pathname}?${params}`);
  }, [category, projectId, submittedSearch, workspaceId]);

  const resetPage = () => { setCursors([undefined]); setPageIndex(0); };
  const visibleProjects = projects.filter((project) => !workspaceId || project.workspaceId === workspaceId);
  const returnParams = new URLSearchParams({ inbox: "proposals" });
  if (workspaceId) returnParams.set("workspace", workspaceId);
  if (projectId) returnParams.set("projectFilter", projectId);
  if (category) returnParams.set("attention", category);
  if (submittedSearch) returnParams.set("q", submittedSearch);
  const returnTo = `${window.location.pathname}?${returnParams}`;

  return <main className="architecture-inbox" data-testid="architecture-inbox">
    <PageHeader eyebrow="Cross-project governance" title="Architecture Inbox" description="Review submitted architectural proposals across the workspaces you can access." />
    {unavailableNotice ? <p className="architecture-inbox__error" role="alert">This proposal is unavailable or you no longer have access. You are back in the Inbox. <button type="button" className="button button--small" onClick={() => { setUnavailableNotice(false); const params = new URLSearchParams(window.location.search); params.delete("unavailable"); window.history.replaceState({}, "", `${window.location.pathname}?${params}`); }}>Dismiss</button></p> : null}
    <section className="architecture-inbox__summary" aria-label="Proposal attention summary">
      {Object.entries(categoryLabels).map(([key, label]) => <button key={key} type="button" aria-pressed={category === key} onClick={() => { setCategory(category === key ? "" : key); resetPage(); }}><strong>{result?.counts[key as keyof ServerProposalInbox["counts"]] ?? "—"}</strong><span>{label}</span></button>)}
    </section>
    <form className="architecture-inbox__filters" onSubmit={(event) => { event.preventDefault(); setSubmittedSearch(search.trim()); resetPage(); }}>
      <label><span>Workspace</span><select value={workspaceId} onChange={(event) => { setWorkspaceId(event.target.value); setProjectId(""); resetPage(); }}><option value="">All accessible workspaces</option>{workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}</select></label>
      <label><span>Project</span><select value={projectId} onChange={(event) => { setProjectId(event.target.value); resetPage(); }}><option value="">All accessible projects</option>{visibleProjects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
      <label><span>Situation</span><select value={category} onChange={(event) => { setCategory(event.target.value); resetPage(); }}><option value="NEEDS_ATTENTION">Pending attention</option><option value="">All situations</option>{Object.entries(categoryLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
      <label className="architecture-inbox__search"><span>Proposal title</span><input type="search" maxLength={200} value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search titles" /></label>
      <button type="submit" className="button">Search</button>
    </form>
    {error ? <p className="architecture-inbox__error" role="alert">{error} <button type="button" className="button button--small" onClick={() => resetPage()}>Retry</button></p> : null}
    {loading && !result ? <p role="status">Loading proposals…</p> : null}
    {!loading && result?.items.length === 0 ? <p className="architecture-inbox__empty">{!workspaceId && !projectId && !submittedSearch && Object.values(result.counts).every((count) => count === 0) ? "No proposals are available in your accessible workspaces." : "No proposals match these filters."}</p> : null}
    {result?.items.length ? <>
      <ul className="architecture-inbox__list" aria-busy={loading}>
        {result.items.map((item) => <li key={`${item.project.id}:${item.proposalId}`}>
          <button type="button" className="architecture-inbox__item" onClick={() => onOpen(item, returnTo)}>
            <span className="architecture-inbox__item-heading"><strong>{item.title}</strong><span>{categoryLabels[item.attentionCategory]}</span></span>
            <span className="architecture-inbox__location">{item.workspace.name} <span aria-hidden="true">/</span> {item.project.name}</span>
            <span>Review: {item.review.status} · {item.review.approvals} approvals · {item.review.changesRequested} change requests</span>
            <span>Promotion: {item.promotion.status ?? "not promoted"} · by {displayName(item)}</span>
            <time dateTime={item.lastActivityAt}>Activity {new Date(item.lastActivityAt).toLocaleString()}</time>
          </button>
        </li>)}
      </ul>
      <nav className="architecture-inbox__pagination" aria-label="Inbox pages">
        <button type="button" className="button" disabled={pageIndex === 0 || loading} onClick={() => setPageIndex((index) => index - 1)}>Previous</button>
        <span>Page {pageIndex + 1}</span>
        <button type="button" className="button" disabled={!result.nextCursor || loading} onClick={() => { setCursors((current) => [...current.slice(0, pageIndex + 1), result.nextCursor!]); setPageIndex((index) => index + 1); }}>Next</button>
      </nav>
    </> : null}
  </main>;
}
