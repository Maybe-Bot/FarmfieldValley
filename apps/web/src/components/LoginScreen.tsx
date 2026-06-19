import { FormEvent, useState } from "react";
import { api } from "../api";
import { EMAIL_VERIFICATION_BYPASS_ADDRESS, validateAccountInputs } from "../account-utils";
import { SessionInfo } from "../types";

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
  const [mode, setMode] = useState<"login" | "register">("login");
  const [farmName, setFarmName] = useState("");
  const [email, setEmail] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [status, setStatus] = useState<string | null>(() => {
    if (typeof window === "undefined") {
      return null;
    }
    const verified = new URLSearchParams(window.location.search).get("verified");
    if (verified === "invalid") {
      return "That verification link is invalid or expired.";
    }
    if (verified === "missing") {
      return "That verification link is missing its token.";
    }
    return null;
  });
  const [saving, setSaving] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [feedbackComment, setFeedbackComment] = useState("");
  const [feedbackStatus, setFeedbackStatus] = useState<string | null>(null);
  const [isSavingFeedback, setIsSavingFeedback] = useState(false);
  const passwordHelp = "Password requirements: at least 8 characters, including one letter and one number.";
  const emailHelp = `Use a real email for beta accounts. ${EMAIL_VERIFICATION_BYPASS_ADDRESS} is reusable for throwaway testing accounts.`;
  const repoUrl = "https://github.com/Maybe-Bot/FarmfieldValley";

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
      setFeedbackStatus("Suggestion/problem saved.");
      window.setTimeout(() => {
        setFeedbackOpen(false);
        setFeedbackStatus(null);
      }, 800);
    } catch (feedbackError) {
      setFeedbackStatus(feedbackError instanceof Error ? feedbackError.message : "Could not save suggestion/problem.");
    } finally {
      setIsSavingFeedback(false);
    }
  }

  return (
    <div className={`auth-shell theme-${themeMode}`}>
      {feedbackOpen && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="login-feedback-title">
          <div className="card feedback-dialog">
            <h2 id="login-feedback-title">Suggestion/problem</h2>
            <p className="muted">Comment is optional. This saves the login page state and current error message, if any.</p>
            <form className="mini-form" onSubmit={submitLoginFeedback}>
              <label>
                <span>Comment</span>
                <textarea
                  rows={5}
                  value={feedbackComment}
                  onChange={(event) => setFeedbackComment(event.target.value)}
                  placeholder="What happened, or what would make this easier?"
                />
              </label>
              {feedbackStatus && <p className="muted"><strong>{feedbackStatus}</strong></p>}
              <div className="button-row">
                <button className="primary-button" type="submit" disabled={isSavingFeedback}>
                  {isSavingFeedback ? "Saving..." : "Submit suggestion/problem"}
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
          <p className="eyebrow">Open source crop planning</p>
          <h1 id="about-title">Loam Ledger</h1>
          <div className="auth-about-copy">
            <p>
              The project is open source: the code is public, user data is exportable, and anyone can self-host it:{" "}
              <a href={repoUrl} target="_blank" rel="noreferrer">GitHub repository</a>.
            </p>
            <p>
              Loam Ledger is for making and executing crop plans: knowing what needs doing, where, and when. A tool, steel or code, should increase a farm's independence, not limit it.
            </p>
            <p className="auth-privacy-note">
              Please do not share the app publicly yet. The server has limited capacity and is running from my bedroom closet.
            </p>
          </div>
          <div className="auth-app-preview" aria-hidden="true">
            <img src="/assets/about-loam-ledger.png" alt="" />
          </div>
        </section>
        <div className="card auth-card">
          <p className="eyebrow">Account access</p>
          <h2>{mode === "login" ? "Farm login" : "Create farm account"}</h2>
          <p className="muted">
            {mode === "login"
              ? "Sign in to your farm account. Planner accounts can manage plans. Worker accounts can record completed work."
              : "Create a new farm and its first planner account. After that, create worker or planner logins from Settings."}
          </p>
          {(error || status) && <p className="muted"><strong>{status ?? error}</strong></p>}
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
                try {
                  setSaving(true);
                  setStatus(mode === "login" ? "Signing in..." : "Creating account...");
                  if (mode === "login") {
                    await onLogin(username, password);
                  } else {
                    const nextSession = await onRegister(farmName, displayName, email, username, password);
                    if (!nextSession.authenticated && nextSession.verificationRequired) {
                      setStatus(`Check ${nextSession.email ?? "your email"} for the verification link before logging in.`);
                      return;
                    }
                  }
                  setStatus(null);
                } catch (loginError) {
                  setStatus(loginError instanceof Error ? loginError.message : mode === "login" ? "Login failed." : "Account creation failed.");
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
                <p className="muted full-span">{emailHelp}</p>
              </>
            )}
            <label className="full-span">
              <span>Username</span>
              <input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" required minLength={3} />
            </label>
            <label className="full-span">
              <span>Password</span>
              <input
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                type="password"
                autoComplete={mode === "login" ? "current-password" : "new-password"}
                required
                minLength={mode === "register" ? 8 : undefined}
              />
            </label>
            {mode === "register" && <p className="muted full-span">{passwordHelp}</p>}
            <button
              className="primary-button full-span"
              disabled={saving}
            >
              {saving ? (mode === "login" ? "Signing in..." : "Creating...") : (mode === "login" ? "Log in" : "Create farm account")}
            </button>
          </form>
        </div>
      </main>
      <footer className="page-feedback-bar auth-feedback-bar">
        <button className="secondary-button" type="button" onClick={() => setFeedbackOpen(true)}>
          Suggestion/problem
        </button>
      </footer>
    </div>
  );
}
