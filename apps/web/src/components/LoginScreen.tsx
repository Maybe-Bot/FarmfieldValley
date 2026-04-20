import { FormEvent, useState } from "react";
import { api } from "../api";
import { validateAccountInputs } from "../account-utils";

type LoginScreenProps = {
  error: string | null;
  onLogin: (username: string, password: string) => Promise<void>;
  onRegister: (farmName: string, displayName: string, username: string, password: string) => Promise<void>;
  onAdminBootstrap: (displayName: string, username: string, password: string) => Promise<void>;
  themeMode: "light" | "dark";
};

// Login, first-farm registration, and first-admin bootstrap screen.
export function LoginScreen({
  error,
  onLogin,
  onRegister,
  onAdminBootstrap,
  themeMode
}: LoginScreenProps) {
  const [mode, setMode] = useState<"login" | "register" | "admin">("login");
  const [farmName, setFarmName] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [feedbackComment, setFeedbackComment] = useState("");
  const [feedbackStatus, setFeedbackStatus] = useState<string | null>(null);
  const [isSavingFeedback, setIsSavingFeedback] = useState(false);
  const passwordHelp = "Password requirements: at least 8 characters, including one letter and one number.";

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
      <button className="secondary-button auth-feedback-button" type="button" onClick={() => setFeedbackOpen(true)}>
        Suggestion/problem
      </button>
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
      <div className="card auth-card">
        <p className="eyebrow">FarmMan Prototype</p>
        <h2>{mode === "login" ? "Farm login" : mode === "admin" ? "Create first admin" : "Create farm account"}</h2>
        <p className="muted">
          {mode === "login"
            ? "Sign in to your farm account. Planner accounts can manage plans. Worker accounts can record completed work."
            : mode === "admin"
              ? "Create the first global admin account. This only works if no admin exists yet."
              : "Create a new farm and its first planner account. After that, create worker or planner logins from Settings."}
        </p>
        {(error || status) && <p className="muted"><strong>{status ?? error}</strong></p>}
        <div className="button-row">
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
          <button
            type="button"
            className={mode === "admin" ? "primary-button compact-button" : "secondary-button compact-button"}
            onClick={() => {
              setMode("admin");
              setStatus(null);
            }}
          >
            First admin
          </button>
        </div>
        <form
          className="form-grid"
          onSubmit={(event) => {
            event.preventDefault();
            void (async () => {
              if (mode === "register") {
                const validationError = validateAccountInputs({ farmName, username, password });
                if (validationError) {
                  setStatus(validationError);
                  return;
                }
              }
              if (mode === "admin") {
                const validationError = validateAccountInputs({ username, password });
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
                } else if (mode === "admin") {
                  await onAdminBootstrap(displayName, username, password);
                } else {
                  await onRegister(farmName, displayName, username, password);
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
            </>
          )}
          {mode === "admin" && (
            <label className="full-span">
              <span>Your name</span>
              <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="Admin" />
            </label>
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
              minLength={mode === "register" || mode === "admin" ? 8 : undefined}
            />
          </label>
          {(mode === "register" || mode === "admin") && <p className="muted full-span">{passwordHelp}</p>}
          <button
            className="primary-button full-span"
            disabled={saving}
          >
            {saving ? (mode === "login" ? "Signing in..." : "Creating...") : (mode === "login" ? "Log in" : mode === "admin" ? "Create admin account" : "Create farm account")}
          </button>
        </form>
        <div className="auth-demo-list">
          <strong>Seeded demo accounts</strong>
          <div className="table-subtle">`river_owner` / `river123`</div>
          <div className="table-subtle">`river_crew` / `river123`</div>
          <div className="table-subtle">`cedar_owner` / `cedar123`</div>
          <div className="table-subtle">`cedar_crew` / `cedar123`</div>
        </div>
      </div>
    </div>
  );
}
