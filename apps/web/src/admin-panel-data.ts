import type { AdminUser, FeedbackReport, UndoSnapshotSummary, UndoState, UsageEvent, UserMessage } from "./types";

type UnknownRecord = Record<string, unknown>;
type AdminMembership = AdminUser["memberships"][number];

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }

  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function asArray(value: unknown): unknown[] {
  const parsed = parseMaybeJson(value);
  return Array.isArray(parsed) ? parsed : [];
}

function asString(value: unknown, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function asNullableString(value: unknown) {
  return typeof value === "string" ? value : null;
}

function asNumber(value: unknown, fallback = 0) {
  const next = typeof value === "number" ? value : Number(value);
  return Number.isFinite(next) ? next : fallback;
}

function asBoolean(value: unknown, fallback = false) {
  return typeof value === "boolean" ? value : fallback;
}

function asObject(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function normalizeMemberships(input: unknown): AdminMembership[] {
  return asArray(input)
    .map((item): AdminMembership | null => {
      if (!isRecord(item)) {
        return null;
      }
      const farmId = asNumber(item.farmId, NaN);
      const farmName = asString(item.farmName);
      const role = asString(item.role) as AdminMembership["role"];
      if (!Number.isFinite(farmId) || !farmName || !role) {
        return null;
      }
      return { farmId, farmName, role };
    })
    .filter((item): item is AdminMembership => item != null);
}

export function normalizeAdminUsers(input: unknown): AdminUser[] {
  return asArray(input)
    .map((item): AdminUser | null => {
      if (!isRecord(item)) {
        return null;
      }
      const id = asNumber(item.id, NaN);
      const username = asString(item.username);
      if (!Number.isFinite(id) || !username) {
        return null;
      }
      return {
        id,
        username,
        displayName: asNullableString(item.displayName),
        isActive: asBoolean(item.isActive, true),
        isAdmin: asBoolean(item.isAdmin),
        createdAt: asString(item.createdAt),
        lastSessionAt: asNullableString(item.lastSessionAt),
        feedbackCount: asNumber(item.feedbackCount),
        memberships: normalizeMemberships(item.memberships)
      };
    })
    .filter((item): item is AdminUser => item != null);
}

export function normalizeUsageEventsResponse(input: unknown): { events: UsageEvent[]; retentionDays: number } {
  const payload = isRecord(input) ? input : {};
  const events = asArray(payload.events)
    .map((item): UsageEvent | null => {
      if (!isRecord(item)) {
        return null;
      }
      const id = asNumber(item.id, NaN);
      if (!Number.isFinite(id)) {
        return null;
      }
      return {
        id,
        eventType: asString(item.eventType, "unknown"),
        page: asString(item.page, "unknown"),
        occurredAt: asString(item.occurredAt),
        details: Object.fromEntries(
          Object.entries(asObject(item.details)).map(([key, value]) => [key, value == null ? null : String(value)])
        ),
        createdAt: asString(item.createdAt)
      };
    })
    .filter((item): item is UsageEvent => item != null);

  return {
    events,
    retentionDays: asNumber(payload.retentionDays, 90)
  };
}

export function normalizeFeedbackReports(input: unknown): FeedbackReport[] {
  return asArray(input)
    .map((item): FeedbackReport | null => {
      if (!isRecord(item)) {
        return null;
      }
      const id = asNumber(item.id, NaN);
      if (!Number.isFinite(id)) {
        return null;
      }
      return {
        id,
        farmId: item.farmId == null ? null : asNumber(item.farmId),
        userId: item.userId == null ? null : asNumber(item.userId),
        username: asString(item.username, "anonymous"),
        displayName: asNullableString(item.displayName),
        page: asString(item.page, "unknown"),
        comment: asNullableString(item.comment),
        context: asObject(item.context),
        recentActivity: asArray(item.recentActivity).filter(isRecord),
        userAgent: asNullableString(item.userAgent),
        createdAt: asString(item.createdAt),
        replyCount: asNumber(item.replyCount),
        lastReplyAt: asNullableString(item.lastReplyAt)
      };
    })
    .filter((item): item is FeedbackReport => item != null);
}

export function normalizeUserMessages(input: unknown): UserMessage[] {
  return asArray(input)
    .map((item): UserMessage | null => {
      if (!isRecord(item)) {
        return null;
      }
      const id = asNumber(item.id, NaN);
      const recipientUserId = asNumber(item.recipientUserId, NaN);
      if (!Number.isFinite(id) || !Number.isFinite(recipientUserId)) {
        return null;
      }
      return {
        id,
        farmId: item.farmId == null ? null : asNumber(item.farmId),
        senderUserId: item.senderUserId == null ? null : asNumber(item.senderUserId),
        senderUsername: asNullableString(item.senderUsername),
        senderDisplayName: asNullableString(item.senderDisplayName),
        recipientUserId,
        relatedFeedbackReportId: item.relatedFeedbackReportId == null ? null : asNumber(item.relatedFeedbackReportId),
        subject: asString(item.subject, "Message"),
        body: asString(item.body),
        readAt: asNullableString(item.readAt),
        createdAt: asString(item.createdAt)
      };
    })
    .filter((item): item is UserMessage => item != null);
}

function normalizeUndoSnapshots(input: unknown): UndoSnapshotSummary[] {
  return asArray(input)
    .map((item): UndoSnapshotSummary | null => {
      if (!isRecord(item)) {
        return null;
      }
      const id = asNumber(item.id, NaN);
      if (!Number.isFinite(id)) {
        return null;
      }
      return {
        id,
        label: asString(item.label, "Recent change"),
        createdAt: asString(item.createdAt)
      };
    })
    .filter((item): item is UndoSnapshotSummary => item != null);
}

export function normalizeUndoState(input: unknown): UndoState {
  const payload = isRecord(input) ? input : {};
  return {
    undo: normalizeUndoSnapshots(payload.undo),
    redo: normalizeUndoSnapshots(payload.redo)
  };
}
