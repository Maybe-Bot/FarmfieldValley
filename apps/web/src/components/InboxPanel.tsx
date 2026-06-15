import { useState } from "react";
import { api } from "../api";
import { formatDate } from "../display-utils";
import { UserMessage } from "../types";

type InboxPanelProps = {
  messages: UserMessage[];
  onMessageRead: (id: number) => void;
  onRefresh: () => Promise<void>;
};

function senderLabel(message: UserMessage) {
  return message.senderDisplayName ?? message.senderUsername ?? "Loam Ledger";
}

export function InboxPanel({ messages, onMessageRead, onRefresh }: InboxPanelProps) {
  const [status, setStatus] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<number | null>(null);

  async function markRead(message: UserMessage) {
    try {
      setSavingId(message.id);
      setStatus(null);
      await api.markMessageRead(message.id);
      onMessageRead(message.id);
      setStatus("Message marked read.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not update message.");
    } finally {
      setSavingId(null);
    }
  }

  async function refresh() {
    try {
      setStatus(null);
      await onRefresh();
      setStatus("Inbox refreshed.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not refresh inbox.");
    }
  }

  return (
    <section className="content-grid">
      <div className="card inbox-card">
        <div className="section-header">
          <div>
            <h2>Inbox</h2>
            <p className="muted">Replies from admins and future direct messages.</p>
          </div>
          <button type="button" className="secondary-button" onClick={() => void refresh()}>
            Refresh
          </button>
        </div>
        {status && <p className="muted"><strong>{status}</strong></p>}
        {messages.length === 0 ? (
          <p className="muted">No messages yet.</p>
        ) : (
          <div className="inbox-list">
            {messages.map((message) => (
              <article key={message.id} className={`inbox-message${message.readAt ? "" : " unread"}`}>
                <div className="inbox-message-header">
                  <div>
                    <h3>{message.subject}</h3>
                    <p className="muted">
                      {senderLabel(message)} • {formatDate(message.createdAt)}
                    </p>
                  </div>
                  {!message.readAt && <span className="status-pill">Unread</span>}
                </div>
                <p className="inbox-message-body">{message.body}</p>
                <div className="inline-actions">
                  {message.relatedFeedbackReportId != null && (
                    <span className="small-chip">Report #{message.relatedFeedbackReportId}</span>
                  )}
                  <button
                    type="button"
                    className="secondary-button compact-button"
                    disabled={Boolean(message.readAt) || savingId === message.id}
                    onClick={() => void markRead(message)}
                  >
                    {savingId === message.id ? "Saving..." : message.readAt ? "Read" : "Mark read"}
                  </button>
                </div>
              </article>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
