import { useEffect, useState } from "react";
import { api } from "../api";
import { roleLabel } from "../account-utils";
import { formatDate } from "../display-utils";
import { AdminUser, FeedbackReport } from "../types";

type AdminPanelProps = {
  reports: FeedbackReport[];
  onRefresh: () => Promise<void>;
  onOpenFeedback: () => void;
};

// Bare-bones global admin screen. Farm-level tools should stay elsewhere so
// normal farm users do not need to understand global admin controls.
export function AdminPanel({ reports, onRefresh, onOpenFeedback }: AdminPanelProps) {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [loadingUsers, setLoadingUsers] = useState(false);

  async function loadUsers() {
    try {
      setLoadingUsers(true);
      setStatus(null);
      setUsers(await api.getAdminUsers());
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not load admin users.");
    } finally {
      setLoadingUsers(false);
    }
  }

  useEffect(() => {
    void loadUsers();
  }, []);

  async function deleteUser(user: AdminUser) {
    const confirmed = window.confirm(`Delete user "${user.username}"? This disables their login and signs them out.`);
    if (!confirmed) {
      return;
    }

    try {
      setStatus(`Deleting ${user.username}...`);
      await api.deleteAdminUser(user.id);
      await loadUsers();
      await onRefresh();
      setStatus("User deleted.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not delete user.");
    }
  }

  return (
    <section className="content-grid split-grid">
      <div className="stack">
        <div className="card">
          <div className="section-header">
            <div>
              <h2>Admin control panel</h2>
              <p className="muted">Bare-bones global controls for the local prototype.</p>
            </div>
            <button type="button" className="primary-button" onClick={onOpenFeedback}>
              Suggestion/problem
            </button>
          </div>
          {status && <p className="muted"><strong>{status}</strong></p>}
        </div>
        <div className="card">
          <h2>Users</h2>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>User</th>
                  <th>Status</th>
                  <th>Farms</th>
                  <th>Created</th>
                  <th>Last login</th>
                  <th>Feedback</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {users.map((user) => (
                  <tr key={user.id}>
                    <td>
                      <strong>{user.username}</strong>
                      <div className="table-subtle">{user.displayName ?? "No display name"}{user.isAdmin ? " / admin" : ""}</div>
                    </td>
                    <td>{user.isActive ? "active" : "deleted"}</td>
                    <td>{user.memberships.map((membership) => `${membership.farmName} (${roleLabel(membership.role)})`).join(", ") || "—"}</td>
                    <td>{formatDate(user.createdAt)}</td>
                    <td>{formatDate(user.lastSessionAt)}</td>
                    <td>{user.feedbackCount}</td>
                    <td>
                      <button
                        type="button"
                        className="danger-button compact-button"
                        disabled={!user.isActive || user.isAdmin}
                        onClick={() => void deleteUser(user)}
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
                {users.length === 0 && (
                  <tr><td colSpan={7}>{loadingUsers ? "Loading users..." : "No users found."}</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
      <div className="stack">
        <FeedbackReportsCard reports={reports} />
      </div>
    </section>
  );
}

// Shows saved Suggestion/problem reports with enough context to reproduce issues.
function FeedbackReportsCard({ reports }: { reports: FeedbackReport[] }) {
  return (
    <div className="card">
      <h2>Recent reports</h2>
      <p className="muted">Problem reports and suggestions submitted from the top-right button.</p>
      {reports.length === 0 ? (
        <p className="muted">No reports yet.</p>
      ) : (
        <div className="feedback-list">
          {reports.slice(0, 12).map((report) => (
            <article key={report.id} className="feedback-item">
              <strong>{report.comment?.trim() || "No comment"}</strong>
              <p className="muted">
                {formatDate(report.createdAt)} • {report.displayName ?? report.username} • {report.page}
              </p>
              <details>
                <summary>Context and activity</summary>
                <pre className="feedback-context">
                  {JSON.stringify({
                    context: report.context,
                    recentActivity: report.recentActivity
                  }, null, 2)}
                </pre>
              </details>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
