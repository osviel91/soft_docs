import { useEffect, useMemo, useState } from "react";
import { ApiError } from "../../workspace/server/api-errors";
import { ServerApiClient } from "../../workspace/server/api-client";
import { useAuth } from "./use-auth";
import LoginScreen from "./LoginScreen";

export default function WorkspaceInvitationPage() {
  const client = useMemo(() => new ServerApiClient(), []);
  const auth = useAuth(client);
  const token = window.location.pathname.slice("/invite/".length);
  const [preview, setPreview] = useState<Awaited<ReturnType<typeof client.inspectWorkspaceInvitation>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    void client.inspectWorkspaceInvitation(token).then(value => { if (active) setPreview(value); }).catch(() => { if (active) setError("This invitation is unavailable. It may have expired, been revoked, or already been used."); });
    return () => { active = false; };
  }, [client, token]);

  const accept = async () => {
    setBusy(true);
    setError(null);
    try {
      const joined = await client.acceptWorkspaceInvitation(token);
      window.location.assign(`/?invitedWorkspace=${encodeURIComponent(joined.workspaceId)}`);
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 409) setError("You already belong to this workspace. Your existing role was not changed.");
      else if (reason instanceof ApiError && reason.status === 401) setError("Sign in to accept this invitation.");
      else setError("This invitation is no longer available. Ask the workspace administrator for a new link.");
      if (!(reason instanceof ApiError && reason.status === 409)) {
        void client.inspectWorkspaceInvitation(token).then(setPreview).catch(() => setPreview(null));
      }
    } finally { setBusy(false); }
  };

  return <main className="login-page invitation-page" data-testid="invitation-page">
    <section className="login-card" aria-labelledby="invitation-title">
      <p className="login-card__eyebrow">Workspace invitation</p>
      <h1 id="invitation-title">Join a workspace</h1>
      {preview ? <>
        <p className="login-card__lead"><strong>{preview.inviterName}</strong> invited you to <strong>{preview.workspaceName}</strong> as <strong>{preview.role}</strong>.</p>
        {auth.status === "loading" ? <p role="status">Checking your sign-in…</p> : auth.status === "authenticated" ? <>
          {(auth.user?.accountStatus === "PENDING" || auth.user?.accountStatus === "SUSPENDED")
            ? <p className="login-card__message">Your account must be active before you can join this workspace.</p>
            : <button className="button login-form__submit" type="button" disabled={busy} onClick={() => void accept()}>{busy ? "Joining…" : "Accept invitation"}</button>}
        </> : <>
          <p>Sign in or create an account to continue. Acceptance is a separate step after authentication.</p>
          <LoginScreen auth={auth} invitationMode />
        </>}
        <p className="invitation-page__scope">Workspace access does not grant access to any project by itself.</p>
      </> : error ? <p role="alert" className="login-card__error">{error}</p> : <p role="status">Checking invitation…</p>}
      {error && preview && <p role="alert" className="login-card__error">{error}</p>}
    </section>
  </main>;
}
