import { FormEvent, useEffect, useState } from "react";
import { api } from "../api";
import { isTightAccountEmail, roleLabel } from "../account-utils";
import { formatDate } from "../display-utils";
import { FarmAccount, FarmInvitation, FarmRole } from "../types";
import { MobileListLimiter } from "./MobileListLimiter";

type TeamAccountsCardProps = {
  farmName: string;
  currentUserId: number;
};

export function TeamAccountsCard({ farmName, currentUserId }: TeamAccountsCardProps) {
  const [accounts, setAccounts] = useState<FarmAccount[]>([]);
  const [invitations, setInvitations] = useState<FarmInvitation[]>([]);
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [role, setRole] = useState<FarmRole>("worker");
  const [status, setStatus] = useState<string | null>(null);
  const [developmentActionUrl, setDevelopmentActionUrl] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function loadTeam() {
    const [nextAccounts, nextInvitations] = await Promise.all([
      api.getAccounts(),
      api.getInvitations()
    ]);
    setAccounts(nextAccounts);
    setInvitations(nextInvitations);
  }

  useEffect(() => {
    void loadTeam().catch((error) => {
      setStatus(error instanceof Error ? error.message : "Could not load team accounts.");
    });
  }, []);

  async function submitInvitation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!isTightAccountEmail(email)) {
      setStatus("Enter a valid email address.");
      return;
    }
    try {
      setSaving(true);
      setStatus("Sending invitation...");
      setDevelopmentActionUrl(null);
      const invitation = await api.createInvitation({
        email,
        displayName: displayName.trim() || null,
        role
      });
      setEmail("");
      setDisplayName("");
      setRole("worker");
      setDevelopmentActionUrl(invitation.developmentActionUrl ?? null);
      setStatus(invitation.developmentActionUrl
        ? "Development invitation created. Open the link below to test it."
        : "Invitation sent. The invitee will choose their own username and password.");
      await loadTeam();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not send invitation.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="card">
      <h2>Team access</h2>
      <p className="muted">
        Invite people to {farmName}. They choose their own password. Planners can edit plans; workers can record completed work.
      </p>
      {status && <p className="muted"><strong>{status}</strong></p>}
      {developmentActionUrl && (
        <p className="muted">
          <a href={developmentActionUrl}>Open development invitation</a>
        </p>
      )}

      <MobileListLimiter itemCount={accounts.length} itemLabel="team members">
        <table className="data-table">
          <thead>
            <tr>
              <th>Member</th>
              <th>Role</th>
              <th>Joined</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {accounts.map((account) => (
              <tr key={account.id}>
                <td>
                  <strong>{account.displayName ?? account.username}</strong>
                  <div className="muted">{account.email ?? account.username}</div>
                </td>
                <td>
                  <select
                    aria-label={`Role for ${account.username}`}
                    value={account.role}
                    disabled={saving || account.id === currentUserId}
                    onChange={(event) => {
                      const nextRole = event.target.value as FarmRole;
                      void (async () => {
                        try {
                          setSaving(true);
                          setStatus("Changing role...");
                          await api.updateAccountRole(account.id, nextRole);
                          await loadTeam();
                          setStatus("Role changed.");
                        } catch (error) {
                          setStatus(error instanceof Error ? error.message : "Could not change role.");
                        } finally {
                          setSaving(false);
                        }
                      })();
                    }}
                  >
                    <option value="worker">Worker</option>
                    <option value="planner">Planner</option>
                  </select>
                </td>
                <td>{formatDate(account.createdAt)}</td>
                <td>
                  {account.id === currentUserId ? (
                    <span className="muted">Current account</span>
                  ) : (
                    <button
                      type="button"
                      className="secondary-button compact-button"
                      disabled={saving}
                      onClick={() => {
                        if (!window.confirm(`Remove ${account.displayName ?? account.username} from ${farmName}? Their account will remain active for any other farms.`)) {
                          return;
                        }
                        void (async () => {
                          try {
                            setSaving(true);
                            setStatus("Removing farm access...");
                            await api.removeAccountFromFarm(account.id);
                            await loadTeam();
                            setStatus("Farm access removed. The person’s account was not disabled globally.");
                          } catch (error) {
                            setStatus(error instanceof Error ? error.message : "Could not remove farm access.");
                          } finally {
                            setSaving(false);
                          }
                        })();
                      }}
                    >
                      Remove from farm
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </MobileListLimiter>

      {invitations.length > 0 && (
        <>
          <h3>Pending invitations</h3>
          <MobileListLimiter itemCount={invitations.length} itemLabel="pending invitations">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Email</th>
                  <th>Role</th>
                  <th>Expires</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {invitations.map((invitation) => (
                  <tr key={invitation.id}>
                    <td>{invitation.email}</td>
                    <td>{roleLabel(invitation.role)}</td>
                    <td>{formatDate(invitation.expiresAt)}</td>
                    <td>
                      <button
                        type="button"
                        className="secondary-button compact-button"
                        disabled={saving}
                        onClick={() => {
                          void (async () => {
                            try {
                              setSaving(true);
                              await api.cancelInvitation(invitation.id);
                              await loadTeam();
                              setStatus("Invitation cancelled.");
                            } catch (error) {
                              setStatus(error instanceof Error ? error.message : "Could not cancel invitation.");
                            } finally {
                              setSaving(false);
                            }
                          })();
                        }}
                      >
                        Cancel invitation
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </MobileListLimiter>
        </>
      )}

      <form className="form-grid" onSubmit={submitInvitation}>
        <h3 className="full-span">Invite a team member</h3>
        <label>
          <span>Name</span>
          <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="Alex Rivera" />
        </label>
        <label>
          <span>Email</span>
          <input value={email} onChange={(event) => setEmail(event.target.value)} type="email" autoComplete="email" required />
        </label>
        <label>
          <span>Role</span>
          <select value={role} onChange={(event) => setRole(event.target.value as FarmRole)}>
            <option value="worker">Worker</option>
            <option value="planner">Planner</option>
          </select>
        </label>
        <p className="muted full-span">The invitation expires after seven days. The invitee creates their own login credentials.</p>
        <button className="primary-button full-span" disabled={saving}>
          {saving ? "Saving..." : "Send invitation"}
        </button>
      </form>
    </div>
  );
}

export function AccountPasswordCard() {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  return (
    <div className="card">
      <h2>Change password</h2>
      {status && <p className="muted"><strong>{status}</strong></p>}
      <form
        className="form-grid"
        onSubmit={(event) => {
          event.preventDefault();
          if (newPassword !== confirmPassword) {
            setStatus("New passwords do not match.");
            return;
          }
          void (async () => {
            try {
              setSaving(true);
              setStatus("Changing password...");
              await api.changePassword({ currentPassword, newPassword });
              setCurrentPassword("");
              setNewPassword("");
              setConfirmPassword("");
              setStatus("Password changed. Other signed-in devices were logged out.");
            } catch (error) {
              setStatus(error instanceof Error ? error.message : "Could not change password.");
            } finally {
              setSaving(false);
            }
          })();
        }}
      >
        <label className="full-span">
          <span>Current password</span>
          <input type="password" autoComplete="current-password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} required />
        </label>
        <label>
          <span>New password</span>
          <input type="password" autoComplete="new-password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} minLength={8} required />
        </label>
        <label>
          <span>Confirm new password</span>
          <input type="password" autoComplete="new-password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} minLength={8} required />
        </label>
        <p className="muted full-span">Use at least 8 characters with one letter and one number.</p>
        <button className="primary-button full-span" disabled={saving}>
          {saving ? "Changing..." : "Change password"}
        </button>
      </form>
    </div>
  );
}
