import { FormEvent, useEffect, useState } from "react";
import { api } from "../api";
import { roleLabel } from "../account-utils";
import { normalizeAdminUsers, normalizeFeedbackReports, normalizeUsageEventsResponse } from "../admin-panel-data";
import { formatDate } from "../display-utils";
import { AdminUser, FeedbackReport, UsageEvent } from "../types";
import { MobileListLimiter } from "./MobileListLimiter";

type AdminPanelProps = {
  reports: FeedbackReport[];
  onRefresh: () => Promise<void>;
  onOpenFeedback: () => void;
};

// Bare-bones global admin screen. Farm-level tools should stay elsewhere so
// normal farm users do not need to understand global admin controls.
export function AdminPanel({ reports, onRefresh, onOpenFeedback }: AdminPanelProps) {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [usageEvents, setUsageEvents] = useState<UsageEvent[]>([]);
  const [usageRetentionDays, setUsageRetentionDays] = useState(90);
  const [status, setStatus] = useState<string | null>(null);
  const [loadingUsers, setLoadingUsers] = useState(false);
  const [loadingUsage, setLoadingUsage] = useState(false);
  const safeReports = normalizeFeedbackReports(reports);

  async function loadUsers() {
    try {
      setLoadingUsers(true);
      setStatus(null);
      setUsers(normalizeAdminUsers(await api.getAdminUsers()));
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not load admin users.");
    } finally {
      setLoadingUsers(false);
    }
  }

  async function loadUsageEvents() {
    try {
      setLoadingUsage(true);
      const result = normalizeUsageEventsResponse(await api.getUsageEvents(200));
      setUsageEvents(result.events);
      setUsageRetentionDays(result.retentionDays);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not load usage activity.");
    } finally {
      setLoadingUsage(false);
    }
  }

  useEffect(() => {
    void loadUsers();
    void loadUsageEvents();
  }, []);

  async function refreshAdminData() {
    try {
      setStatus(null);
      await Promise.all([
        loadUsers(),
        loadUsageEvents(),
        onRefresh()
      ]);
      setStatus("Admin data refreshed.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not refresh admin data.");
    }
  }

  async function deleteUser(user: AdminUser) {
    const confirmed = window.confirm(`Delete user "${user.username}"? This disables their login and signs them out.`);
    if (!confirmed) {
      return;
    }

    try {
      setStatus(`Deleting ${user.username}...`);
      await api.deleteAdminUser(user.id);
      await loadUsers();
      await refreshAdminData();
      setStatus("User deleted.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not delete user.");
    }
  }

  async function deleteUsageEvents() {
    if (!window.confirm("Delete all stored anonymous usage information? This cannot be undone.")) return;
    try {
      const result = await api.deleteUsageEvents();
      setUsageEvents([]);
      setStatus(`Deleted ${result.deleted} usage records.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not delete usage information.");
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
            <button type="button" className="secondary-button" onClick={() => void refreshAdminData()}>
              Refresh
            </button>
          </div>
          {status && <p className="muted"><strong>{status}</strong></p>}
        </div>
        <div className="card">
          <h2>Users</h2>
          <MobileListLimiter itemCount={users.length} itemLabel="users">
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
          </MobileListLimiter>
        </div>
      </div>
      <div className="stack">
        <UsageEventsCard
          events={usageEvents}
          loading={loadingUsage}
          retentionDays={usageRetentionDays}
          onDelete={deleteUsageEvents}
        />
        <FeedbackReportsCard reports={safeReports} onRefresh={onRefresh} />
      </div>
    </section>
  );
}

function usageEventSummary(event: UsageEvent) {
  const feature = event.details.feature;
  return feature ? `${event.eventType.replace(/_/g, " ")}: ${feature}` : event.eventType.replace(/_/g, " ");
}

function UsageEventsCard({
  events,
  loading,
  retentionDays,
  onDelete
}: {
  events: UsageEvent[];
  loading: boolean;
  retentionDays: number;
  onDelete: () => Promise<void>;
}) {
  return (
    <div className="card">
      <div className="section-header">
        <div>
          <h2>Anonymous usage</h2>
          <p className="muted">No user, farm, browser, raw URL, click text, or error identifiers. Deleted automatically after {retentionDays} days.</p>
        </div>
        <button type="button" className="danger-button compact-button" disabled={events.length === 0} onClick={() => void onDelete()}>
          Delete all
        </button>
      </div>
      {events.length === 0 ? (
        <p className="muted">{loading ? "Loading usage activity..." : "No usage activity yet."}</p>
      ) : (
        <MobileListLimiter itemCount={events.length} itemLabel="usage records">
          <div className="table-wrap">
            <table className="data-table">
            <thead>
              <tr>
                <th>When</th>
                <th>Page</th>
                <th>Activity</th>
                <th>Time</th>
              </tr>
            </thead>
            <tbody>
              {events.map((event) => (
                <tr key={event.id}>
                  <td>{formatDate(event.occurredAt)}</td>
                  <td>{event.page}</td>
                  <td>{usageEventSummary(event)}</td>
                  <td>{event.details.duration?.replace(/_/g, " ") ?? "—"}</td>
                </tr>
              ))}
            </tbody>
            </table>
          </div>
        </MobileListLimiter>
      )}
    </div>
  );
}

// Shows saved Suggestion/problem reports with enough context to reproduce issues.
function FeedbackReportsCard({ reports, onRefresh }: { reports: FeedbackReport[]; onRefresh: () => Promise<void> }) {
  const [replyDrafts, setReplyDrafts] = useState<Record<number, string>>({});
  const [savingReportId, setSavingReportId] = useState<number | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  async function sendReply(event: FormEvent<HTMLFormElement>, report: FeedbackReport) {
    event.preventDefault();
    const body = replyDrafts[report.id]?.trim() ?? "";
    if (!body) {
      setStatus("Reply message is required.");
      return;
    }

    try {
      setSavingReportId(report.id);
      setStatus(null);
      await api.replyToFeedbackReport(report.id, { body });
      setReplyDrafts((current) => ({ ...current, [report.id]: "" }));
      await onRefresh();
      setStatus("Reply sent to the user's inbox.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not send reply.");
    } finally {
      setSavingReportId(null);
    }
  }

  return (
    <div className="card">
      <h2>Recent reports</h2>
      <p className="muted">Problem reports and suggestions submitted from the top-right button.</p>
      {status && <p className="muted"><strong>{status}</strong></p>}
      {reports.length === 0 ? (
        <p className="muted">No reports yet.</p>
      ) : (
        <MobileListLimiter itemCount={reports.length} itemLabel="reports" forceExpanded={savingReportId != null}>
          <div className="feedback-list">
            {reports.map((report) => (
              <article key={report.id} className="feedback-item">
              <strong>{report.comment?.trim() || "No comment"}</strong>
              <p className="muted">
                {formatDate(report.createdAt)} • {report.displayName ?? report.username} • {report.page}
              </p>
              <p className="muted">
                Replies: {report.replyCount}{report.lastReplyAt ? ` • Last reply ${formatDate(report.lastReplyAt)}` : ""}
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
              {report.userId == null ? (
                <p className="muted">Anonymous report: no inbox reply available.</p>
              ) : (
                <form className="mini-form feedback-reply-form" onSubmit={(event) => void sendReply(event, report)}>
                  <label>
                    <span>Reply to {report.displayName ?? report.username}</span>
                    <textarea
                      rows={3}
                      value={replyDrafts[report.id] ?? ""}
                      onChange={(event) => setReplyDrafts((current) => ({ ...current, [report.id]: event.target.value }))}
                      placeholder="Write a reply that will appear in their inbox"
                    />
                  </label>
                  <button
                    type="submit"
                    className="primary-button compact-button"
                    disabled={savingReportId === report.id}
                  >
                    {savingReportId === report.id ? "Sending..." : "Send reply"}
                  </button>
                </form>
              )}
              </article>
            ))}
          </div>
        </MobileListLimiter>
      )}
    </div>
  );
}
