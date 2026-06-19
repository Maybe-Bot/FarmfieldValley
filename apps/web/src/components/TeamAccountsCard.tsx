import { useState } from "react";
import { api } from "../api";
import { EMAIL_VERIFICATION_BYPASS_ADDRESS, roleLabel, validateAccountInputs } from "../account-utils";
import { formatDate } from "../display-utils";
import { FarmAccount, FarmRole } from "../types";
import { MobileListLimiter } from "./MobileListLimiter";

type TeamAccountsCardProps = {
  farmName: string;
  accounts: FarmAccount[];
  onCreated: () => void;
};

// Farm-level account creation. Planner accounts can change plans; worker
// accounts are limited to recording field work.
export function TeamAccountsCard({ farmName, accounts, onCreated }: TeamAccountsCardProps) {
  const [email, setEmail] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [role, setRole] = useState<FarmRole>("worker");
  const [status, setStatus] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const passwordHelp = "Password requirements: at least 8 characters, including one letter and one number.";
  const emailHelp = `Real accounts must verify email before login. Use ${EMAIL_VERIFICATION_BYPASS_ADDRESS} for reusable testing accounts.`;

  return (
    <div className="card">
      <h2>Team accounts</h2>
      <p className="muted">Create logins for {farmName}. Planner accounts can edit plans. Worker accounts can record completed work.</p>
      {status && <p className="muted"><strong>{status}</strong></p>}
      <MobileListLimiter itemCount={accounts.length} itemLabel="team accounts">
        <table className="data-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Username</th>
            <th>Role</th>
            <th>Created</th>
          </tr>
        </thead>
        <tbody>
          {accounts.map((account) => (
            <tr key={account.id}>
              <td>{account.displayName ?? "—"}</td>
              <td>{account.username}</td>
              <td>{roleLabel(account.role)}</td>
              <td>{formatDate(account.createdAt)}</td>
            </tr>
          ))}
        </tbody>
        </table>
      </MobileListLimiter>
      <form
        className="form-grid"
        onSubmit={(event) => {
          event.preventDefault();
          void (async () => {
            const validationError = validateAccountInputs({ email, username, password });
            if (validationError) {
              setStatus(validationError);
              return;
            }

            try {
              setSaving(true);
              setStatus("Creating account...");
              const createdAccount = await api.createAccount({
                email,
                username,
                password,
                displayName: displayName.trim() || null,
                role
              });
              setEmail("");
              setUsername("");
              setPassword("");
              setDisplayName("");
              setRole("worker");
              setStatus(createdAccount.verificationRequired ? "Account created. Have them check email before logging in." : "Account created.");
              onCreated();
            } catch (error) {
              setStatus(error instanceof Error ? error.message : "Account creation failed.");
            } finally {
              setSaving(false);
            }
          })();
        }}
      >
        <label>
          <span>Display name</span>
          <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="Alex Rivera" />
        </label>
        <label>
          <span>Email</span>
          <input
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            type="email"
            placeholder="alex@example.com"
            autoComplete="email"
            required
          />
        </label>
        <label>
          <span>Username</span>
          <input
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            placeholder="alex_rivera"
            required
            minLength={3}
          />
        </label>
        <label>
          <span>Password</span>
          <input
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            type="password"
            placeholder="At least 8 characters"
            required
            minLength={8}
          />
        </label>
        <p className="muted full-span">{passwordHelp}</p>
        <p className="muted full-span">{emailHelp}</p>
        <label>
          <span>Role</span>
          <select value={role} onChange={(event) => setRole(event.target.value as FarmRole)}>
            <option value="worker">Worker</option>
            <option value="planner">Planner</option>
          </select>
        </label>
        <button className="primary-button full-span" disabled={saving}>
          {saving ? "Creating..." : "Create account"}
        </button>
      </form>
    </div>
  );
}
