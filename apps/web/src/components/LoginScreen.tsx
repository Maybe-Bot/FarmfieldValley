import { FormEvent, useEffect, useState } from "react";
import { api } from "../api";
import { validateAccountInputs } from "../account-utils";
import { AuthCapabilities, InvitationPreview, SessionInfo } from "../types";

type LoginScreenProps = {
  error: string | null;
  onLogin: (username: string, password: string) => Promise<void>;
  onRegister: (farmName: string, displayName: string, email: string, username: string, password: string) => Promise<SessionInfo>;
  themeMode: "light" | "dark";
};

// Login and first-farm registration screen.
export function LoginScreen({
  error,
  onLogin,
  onRegister,
  themeMode
}: LoginScreenProps) {
  const initialParams = typeof window === "undefined" ? new URLSearchParams() : new URLSearchParams(window.location.search);
  const [mode, setMode] = useState<"login" | "register" | "forgot" | "resend" | "reset" | "invite">(
    initialParams.has("reset-password") ? "reset" : initialParams.has("accept-invite") ? "invite" : "login"
  );
  const [actionToken] = useState(initialParams.get("token") ?? "");
  const [farmName, setFarmName] = useState("");
  const [email, setEmail] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [capabilities, setCapabilities] = useState<AuthCapabilities | null>(null);
  const [invitation, setInvitation] = useState<InvitationPreview | null>(null);
  const [developmentActionUrl, setDevelopmentActionUrl] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(() => {
    if (typeof window === "undefined") {
      return null;
    }
    const verified = new URLSearchParams(window.location.search).get("verified");
    if (verified === "invalid") {
      return "This verification link is invalid or expired.";
    }
    if (verified === "missing") {
      return "This verification link is missing a token.";
    }
    return null;
  });
  const [saving, setSaving] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [feedbackComment, setFeedbackComment] = useState("");
  const [feedbackStatus, setFeedbackStatus] = useState<string | null>(null);
  const [isSavingFeedback, setIsSavingFeedback] = useState(false);
  const passwordHelp = "Use at least 8 characters, including one letter and one number.";
  const repoUrl = "https://github.com/Maybe-Bot/FarmfieldValley";

  useEffect(() => {
    void api.getAuthCapabilities().then(setCapabilities).catch(() => setCapabilities(null));
  }, []);

  useEffect(() => {
    if (mode !== "invite" || !actionToken) {
      return;
    }
    void api.inspectInvitation(actionToken)
      .then(setInvitation)
      .catch((inviteError) => setStatus(inviteError instanceof Error ? inviteError.message : "Could not open invitation."));
  }, [mode, actionToken]);

  async function submitLoginFeedback(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFeedbackStatus(null);
    setIsSavingFeedback(true);

    try {
      await api.createFeedback({
        page: "login",
        comment: feedbackComment.trim() || null,
        context: {
          mode,
          enteredUsername: username.trim() || null,
          visibleError: status ?? error,
          browser: typeof window === "undefined" ? null : {
            url: window.location.href,
            viewport: {
              width: window.innerWidth,
              height: window.innerHeight
            }
          }
        },
        recentActivity: [
          {
            at: new Date().toISOString(),
            view: "login",
            action: "login page feedback submitted",
            details: { mode }
          }
        ]
      });
      setFeedbackComment("");
      setFeedbackStatus("Suggestion or problem saved.");
      window.setTimeout(() => {
        setFeedbackOpen(false);
        setFeedbackStatus(null);
      }, 800);
    } catch (feedbackError) {
      setFeedbackStatus(feedbackError instanceof Error ? feedbackError.message : "Could not save suggestion or problem.");
    } finally {
      setIsSavingFeedback(false);
    }
  }

  return (
    <div className={`auth-shell theme-${themeMode}`}>
      {feedbackOpen && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="login-feedback-title">
          <div className="card feedback-dialog">
            <h2 id="login-feedback-title">Suggestion or problem</h2>
            <p className="muted">Comment is optional. This saves the login page state and any current error message.</p>
            <form className="mini-form" onSubmit={submitLoginFeedback}>
              <label>
                <span>Comment</span>
                <textarea
                  rows={5}
                  value={feedbackComment}
                  onChange={(event) => setFeedbackComment(event.target.value)}
                  placeholder="What would you like to be different?"
                />
              </label>
              {feedbackStatus && <p className="muted"><strong>{feedbackStatus}</strong></p>}
              <div className="button-row">
                <button className="primary-button" type="submit" disabled={isSavingFeedback}>
                  {isSavingFeedback ? "Saving..." : "Submit"}
                </button>
                <button
                  className="secondary-button"
                  type="button"
                  onClick={() => {
                    setFeedbackOpen(false);
                    setFeedbackStatus(null);
                  }}
                  disabled={isSavingFeedback}
                >
                  Cancel
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
      <header className="auth-landing-header">
        <strong>Loam Ledger</strong>
        <div className="button-row auth-top-actions">
          <button
            type="button"
            className={mode === "login" ? "primary-button compact-button" : "secondary-button compact-button"}
            onClick={() => {
              setMode("login");
              setStatus(null);
            }}
          >
            Log in
          </button>
          <button
            type="button"
            className={mode === "register" ? "primary-button compact-button" : "secondary-button compact-button"}
            onClick={() => {
              setMode("register");
              setStatus(null);
            }}
          >
            Create account
          </button>
        </div>
      </header>
      <main className="auth-landing-main">
        <section className="auth-about-panel" aria-labelledby="about-title">
          <p className="eyebrow">Open-source crop planning</p>
          <h1 id="about-title">Loam Ledger</h1>
          <div className="auth-about-copy">
            <p>
              This project is open source. The code is public, user data can be exported, and anyone can self-host it:{" "}
              <a href={repoUrl} target="_blank" rel="noreferrer">GitHub repository</a>.
            </p>
            <p>
              Loam Ledger helps farms plan and track crop work: what needs doing, where, and when. Digital tools should increase farm independence, not limit it.
            </p>
            <p className="auth-privacy-note">
              Please do not share this site publicly yet. The server has limited capacity and is running from a bedroom closet.
            </p>
          </div>
          <div className="auth-app-preview" aria-hidden="true">
            <img src="/assets/about-loam-ledger.png" alt="" />
          </div>
        </section>
        <div className="card auth-card">
          <p className="eyebrow">Account access</p>
          <h2>
            {mode === "login" ? "Farm account login"
              : mode === "register" ? "Create farm account"
                : mode === "forgot" ? "Reset your password"
                  : mode === "resend" ? "Resend verification"
                  : mode === "reset" ? "Choose a new password"
                    : "Accept farm invitation"}
          </h2>
          <p className="muted">
            {mode === "login"
              ? "Sign in to your farm account. "
              : mode === "register"
                ? capabilities?.emailVerificationEnabled
                  ? "Create a new farm. We will email a verification link before you can log in."
                  : "Create a new farm and the first planner account. Email verification is off on this development server."
                : mode === "forgot"
                  ? "Enter your account email. If it matches an active account, we will send a reset link that works for one hour."
                  : mode === "resend"
                    ? "Enter your account email. If it still needs verification, we will send a new link that works for 24 hours."
                  : mode === "reset"
                    ? "This will change your password and sign out other devices."
                    : invitation
                      ? invitation.existingAccount
                        ? `Join ${invitation.farmName} using the password for your existing ${invitation.email} account.`
                        : `Join ${invitation.farmName}. Choose a username and password.`
                      : "Checking invitation..."}
          </p>
          {(error || status) && <p className="muted"><strong>{status ?? error}</strong></p>}
          {developmentActionUrl && (
            <p className="muted"><a href={developmentActionUrl}>Open development email link</a></p>
          )}
          <form
            className="form-grid"
            onSubmit={(event) => {
              event.preventDefault();
              void (async () => {
                if (mode === "register") {
                  const validationError = validateAccountInputs({ farmName, email, username, password });
                  if (validationError) {
                    setStatus(validationError);
                    return;
                  }
                }
                if (mode === "invite" && !invitation?.existingAccount) {
                  const validationError = validateAccountInputs({ username, password });
                  if (validationError) {
                    setStatus(validationError);
                    return;
                  }
                }
                if ((mode === "register" || mode === "reset" || (mode === "invite" && !invitation?.existingAccount)) && password !== confirmPassword) {
                  setStatus("Passwords do not match.");
                  return;
                }
                try {
                  setSaving(true);
                  setDevelopmentActionUrl(null);
                  if (mode === "login") {
                    setStatus("Signing in...");
                    await onLogin(username, password);
                    setStatus(null);
                  } else if (mode === "register") {
                    setStatus("Creating account...");
                    const nextSession = await onRegister(farmName, displayName, email, username, password);
                    if (!nextSession.authenticated && nextSession.verificationRequired) {
                      setDevelopmentActionUrl(nextSession.developmentActionUrl ?? null);
                      setStatus(nextSession.developmentActionUrl
                        ? "Account created. Open the development verification link below."
                        : `Check ${nextSession.email ?? "your email"} for the verification link before logging in.`);
                      return;
                    }
                    setStatus(null);
                  } else if (mode === "forgot") {
                    setStatus("Requesting reset link...");
                    const result = await api.forgotPassword({ email });
                    setDevelopmentActionUrl(result.developmentActionUrl ?? null);
                    setStatus(result.developmentActionUrl
                      ? "Open the development reset link below."
                      : "If that email matches an active account, a reset link has been sent.");
                  } else if (mode === "resend") {
                    setStatus("Requesting verification email...");
                    const result = await api.resendVerification({ email });
                    setDevelopmentActionUrl(result.developmentActionUrl ?? null);
                    setStatus(result.developmentActionUrl
                      ? "Open the development verification link below."
                      : "If that account still needs verification, a new link has been sent.");
                  } else if (mode === "reset") {
                    setStatus("Changing password...");
                    await api.resetPassword({ token: actionToken, newPassword: password });
                    setPassword("");
                    setConfirmPassword("");
                    setMode("login");
                    window.history.replaceState({}, "", window.location.pathname);
                    setStatus("Password changed. You can log in now.");
                  } else if (mode === "invite") {
                    setStatus("Accepting invitation...");
                    const nextSession = await api.acceptInvitation({
                      token: actionToken,
                      username: invitation?.existingAccount ? undefined : username,
                      password
                    });
                    if (nextSession.authenticated) {
                      window.history.replaceState({}, "", window.location.pathname);
                      window.location.reload();
                      return;
                    }
                  }
                } catch (loginError) {
                  setStatus(loginError instanceof Error ? loginError.message : "Could not create account.");
                } finally {
                  setSaving(false);
                }
              })();
            }}
          >
            {mode === "register" && (
              <>
                <label className="full-span">
                  <span>Farm name</span>
                  <input value={farmName} onChange={(event) => setFarmName(event.target.value)} placeholder="Oak Hollow Farm" required />
                </label>
                <label className="full-span">
                  <span>Your name</span>
                  <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="Jordan Lee" />
                </label>
                <label className="full-span">
                  <span>Email</span>
                  <input value={email} onChange={(event) => setEmail(event.target.value)} type="email" autoComplete="email" placeholder="you@example.com" required />
                </label>
              </>
            )}
            {(mode === "forgot" || mode === "resend") && (
              <label className="full-span">
                <span>Email</span>
                <input value={email} onChange={(event) => setEmail(event.target.value)} type="email" autoComplete="email" required />
              </label>
            )}
            {(mode === "login" || mode === "register" || (mode === "invite" && !invitation?.existingAccount)) && (
              <label className="full-span">
                <span>Username</span>
                <input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" required minLength={3} />
              </label>
            )}
            {(mode === "login" || mode === "register" || mode === "reset" || mode === "invite") && (
              <label className="full-span">
                <span>{mode === "invite" && invitation?.existingAccount ? "Existing account password" : mode === "login" ? "Password" : "New password"}</span>
                <input
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  type="password"
                  autoComplete={mode === "login" || (mode === "invite" && invitation?.existingAccount) ? "current-password" : "new-password"}
                  required
                  minLength={mode === "login" ? undefined : 8}
                />
              </label>
            )}
            {(mode === "register" || mode === "reset" || (mode === "invite" && !invitation?.existingAccount)) && (
              <label className="full-span">
                <span>Confirm password</span>
                <input
                  value={confirmPassword}
                  onChange={(event) => setConfirmPassword(event.target.value)}
                  type="password"
                  autoComplete="new-password"
                  required
                  minLength={8}
                />
              </label>
            )}
            {(mode === "register" || mode === "reset" || (mode === "invite" && !invitation?.existingAccount)) && <p className="muted full-span">{passwordHelp}</p>}
            <button
              className="primary-button full-span"
              disabled={saving || (mode === "invite" && !invitation)}
            >
              {saving ? "Saving..."
                : mode === "login" ? "Log in"
                  : mode === "register" ? "Create farm account"
                    : mode === "forgot" ? "Send reset link"
                      : mode === "resend" ? "Send verification link"
                      : mode === "reset" ? "Change password"
                        : "Accept invitation"}
            </button>
          </form>
          {mode === "login" && (
            <>
              <button type="button" className="secondary-button full-span" onClick={() => { setMode("forgot"); setStatus(null); }}>
                Forgot password?
              </button>
              <button type="button" className="secondary-button full-span" onClick={() => { setMode("resend"); setStatus(null); }}>
                Resend verification email
              </button>
            </>
          )}
          {(mode === "forgot" || mode === "resend" || mode === "reset") && (
            <button type="button" className="secondary-button full-span" onClick={() => { setMode("login"); setStatus(null); }}>
              Back to log in
            </button>
          )}
        </div>
      </main>
      <footer className="page-feedback-bar auth-feedback-bar">
        <button className="secondary-button" type="button" onClick={() => setFeedbackOpen(true)}>
          Suggestion or problem
        </button>
      </footer>
    </div>
  );
}
