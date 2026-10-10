import { useEffect, useRef, useState } from "react";
import type { ProjectShareRecord, ServerApiClient } from "../../workspace/server/api-client";
import type { ServerResource } from "../../workspace/server/api-client";

const date = (value: string) => new Date(value).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });

export default function ProjectShareDialog({ projectId, client, onClose }: { projectId: string; client: ServerApiClient; onClose: () => void }) {
  const [grants, setGrants] = useState<ProjectShareRecord[]>([]);
  const [resources, setResources] = useState<ServerResource[]>([]);
  const [selectedResourceIds, setSelectedResourceIds] = useState<string[]>([]);
  const [createdUrl, setCreatedUrl] = useState<string | null>(null);
  const [createdExpiry, setCreatedExpiry] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [pendingRevoke, setPendingRevoke] = useState<ProjectShareRecord | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const dialogRef = useRef<HTMLElement>(null);

  const refresh = async () => setGrants(await client.listProjectShares(projectId));
  useEffect(() => { void Promise.all([refresh(), client.listResources(projectId)]).then(([, shared]) => { setResources(shared); setSelectedResourceIds(shared.map(resource => resource.id)); }).catch(() => { setLoadFailed(true); setError("Could not load shared links and resources. Try again."); }); }, [projectId, client]);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const panel = dialogRef.current;
    const focusables = () => [...(pendingRevoke ? panel?.querySelector('[role="alertdialog"]') : panel)?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), [href], [tabindex]:not([tabindex="-1"])') ?? []];
    (focusables()[0] ?? panel)?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); if (pendingRevoke) setPendingRevoke(null); else onClose(); return; }
      if (event.key !== "Tab") return;
      const items = focusables();
      if (!items.length) { event.preventDefault(); return; }
      if (event.shiftKey && document.activeElement === items[0]) { event.preventDefault(); items.at(-1)?.focus(); }
      else if (!event.shiftKey && document.activeElement === items.at(-1)) { event.preventDefault(); items[0].focus(); }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => { document.removeEventListener("keydown", onKeyDown); previous?.focus(); };
  }, [pendingRevoke]);

  const create = async () => {
    setBusy(true); setError(""); setCopied(false);
    try {
      const result = await client.createProjectShare(projectId, selectedResourceIds);
      setCreatedUrl(new URL(`/share/${encodeURIComponent(result.token)}`, window.location.origin).href);
      setCreatedExpiry(result.grant.expiresAt);
      await refresh();
    } catch { setError("Could not create a link. Try again."); }
    finally { setBusy(false); }
  };

  const copy = async () => {
    try { await navigator.clipboard.writeText(createdUrl!); setCopied(true); setError(""); }
    catch { setCopied(false); setError("Copy failed. Select and copy the link above."); }
  };

  const revoke = async () => {
    if (!pendingRevoke) return;
    setBusy(true);
    try { await client.revokeProjectShare(projectId, pendingRevoke.id); setPendingRevoke(null); await refresh(); }
    catch { setError("Could not revoke this link. Try again."); }
    finally { setBusy(false); }
  };

  return <div className="share-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section ref={dialogRef} className="share-dialog" role="dialog" aria-modal="true" aria-labelledby="share-title" tabIndex={-1}>
      <button type="button" className="share-dialog__close" aria-label="Close share management" onClick={onClose}>×</button>
      <p className="login-card__eyebrow">Project sharing</p><h2 id="share-title">Share project</h2>
      <p>Anyone with this link can view the project's shared documentation. The link does not grant editing or workspace membership.</p>
      <fieldset className="share-dialog__resources">
        <legend>Resources this link may expose</legend>
        <p>Bindings are visible only if both endpoint resources are selected. Evidence referring to an unselected resource is marked unavailable.</p>
        <div className="share-dialog__selection-tools">
          <span>{selectedResourceIds.length} of {resources.length} selected</span>
          <div>
            <button type="button" onClick={() => setSelectedResourceIds(resources.map(resource => resource.id))} disabled={selectedResourceIds.length === resources.length}>Select all</button>
            <button type="button" onClick={() => setSelectedResourceIds([])} disabled={selectedResourceIds.length === 0}>Deselect all</button>
          </div>
        </div>
        <div className="share-dialog__resource-list">{resources.map(resource => <label key={resource.id}>
          <input type="checkbox" checked={selectedResourceIds.includes(resource.id)} onChange={event => setSelectedResourceIds(current => event.target.checked ? [...current, resource.id] : current.filter(id => id !== resource.id))} />
          <span>{resource.path}</span><small>{resource.type}</small>
        </label>)}</div>
      </fieldset>
      {createdUrl ? <section aria-label="New link">
        <h3>Link created</h3><label htmlFor="created-share-url">Read-only link</label>
        <input id="created-share-url" readOnly value={createdUrl} onFocus={(event) => event.currentTarget.select()} />
        <button type="button" className="button button--primary" onClick={() => void copy()}>{copied ? "Copied" : "Copy link"}</button>
        <p>Expires {createdExpiry ? date(createdExpiry) : "as shown in Existing links"}</p>
        <small>Keep this link safe. Anyone with it can view this project's shared documentation.</small>
      </section> : <button type="button" className="button button--primary" disabled={busy || selectedResourceIds.length === 0} onClick={() => void create()}>{busy ? "Creating…" : "Create read-only link"}</button>}
      <h3>Existing links</h3>
      {grants.length === 0 ? <p>No links yet.</p> : <ul className="share-link-list">{grants.map((grant) => <li key={grant.id}>
        <strong>{grant.state === "ACTIVE" ? "Active" : grant.state === "EXPIRED" ? "Expired" : "Revoked"}</strong>
        <span>Created {date(grant.createdAt)} · Expires {date(grant.expiresAt)}</span>
        {grant.revokedAt ? <span>Revoked {date(grant.revokedAt)}</span> : null}
        {grant.state === "ACTIVE" ? <button type="button" disabled={busy} onClick={() => setPendingRevoke(grant)}>Revoke</button> : null}
      </li>)}</ul>}
      <p className="share-dialog__footnote">Revoking a link prevents future access through it; it does not erase information already obtained.</p>
      {error ? <p role="alert">{error}</p> : null}
      {loadFailed ? <button type="button" onClick={() => { setLoadFailed(false); void refresh().catch(() => { setLoadFailed(true); setError("Could not load shared links. Try again."); }); }}>Retry loading links</button> : null}
      {pendingRevoke ? <div className="share-confirm" role="alertdialog" aria-modal="true" aria-labelledby="revoke-title" tabIndex={-1}>
        <h3 id="revoke-title">Revoke this link?</h3><p>This link will stop working immediately. Other active links are not affected.</p>
        <button type="button" onClick={() => setPendingRevoke(null)}>Cancel</button><button type="button" className="button button--danger" disabled={busy} onClick={() => void revoke()}>Revoke link</button>
      </div> : null}
    </section>
  </div>;
}
