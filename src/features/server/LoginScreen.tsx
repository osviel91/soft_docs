import { useState, type FormEvent } from "react";
import type { AuthHook } from "./use-auth";

interface LoginScreenProps {
  auth: AuthHook;
  invitationMode?: boolean;
}

export default function LoginScreen({ auth, invitationMode = false }: LoginScreenProps) {
  const Container = invitationMode ? "div" : "main";
  const [localMode, setLocalMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const submitPassword = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (!auth.signInLocal || !auth.registerLocal) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    const action =
      localMode === "login"
        ? auth.signInLocal(email, password).then(() => undefined)
        : auth.registerLocal(email, password, displayName);
    void action
      .then((result) => {
        if (typeof result === "string") setMessage(result);
        if (localMode === "register") setPassword("");
      })
      .catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : "Authentication failed.");
      })
      .finally(() => setBusy(false));
  };

  return (
    <Container className={`login-page${invitationMode ? " login-page--embedded" : ""}`} data-testid="login-page">
      <section className="login-card" aria-labelledby="login-title">
        <div className="login-card__brand">
          <span className="app__brand-mark" aria-hidden="true">
            {"</>"}
          </span>
          <span>Software Docs Manager</span>
        </div>
        {!invitationMode && <p className="login-card__eyebrow">Workspace platform</p>}
        <h2 id="login-title">{invitationMode ? "Sign in or create an account" : "Sign in to continue"}</h2>
        <p className="login-card__lead">
          Choose how you want to access your workspaces and projects.
        </p>

        {auth.status === "authenticated" &&
          (auth.user?.accountStatus === "PENDING" ||
            auth.user?.accountStatus === "SUSPENDED") && (
            <p className="login-card__message" data-testid="login-account-status">
              {auth.user.accountStatus === "PENDING"
                ? "Your account is awaiting administrator approval."
                : "Your account is suspended. Contact an administrator."}
            </p>
          )}

        <p className="login-card__eyebrow">Email &amp; password</p>

          <form className="login-form" onSubmit={submitPassword}>
            {localMode === "register" && (
              <label>
                Display name
                <input
                  data-testid="login-display-name"
                  value={displayName}
                  onChange={(event) => setDisplayName(event.target.value)}
                  autoComplete="name"
                />
              </label>
            )}
            <label>
              Email
              <input
                data-testid="login-email"
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                autoComplete="email"
                required
              />
            </label>
            <label>
              Password
              <input
                data-testid="login-password"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder={localMode === "register" ? "12+ characters" : undefined}
                autoComplete={localMode === "register" ? "new-password" : "current-password"}
                required
              />
            </label>
            <button type="submit" className="button login-form__submit" disabled={busy}>
              {busy ? "Working…" : localMode === "login" ? "Sign in" : "Create account"}
            </button>
            <button
              type="button"
              className="login-form__link"
              onClick={() => {
                setLocalMode((current) => (current === "login" ? "register" : "login"));
                setError(null);
                setMessage(null);
              }}
            >
              {localMode === "login" ? "Create a local account" : "Use an existing account"}
            </button>
          </form>

        <div className="login-divider"><span>or</span></div>
        <button
          type="button"
          className="button login-google"
          data-testid="login-google"
          onClick={auth.signIn}
        >
          Continue with Google
        </button>

        {error && <p className="login-card__error" data-testid="login-error">{error}</p>}
        {message && <p className="login-card__message" data-testid="login-message">{message}</p>}
      </section>
    </Container>
  );
}
