/**
 * Frontend API wrapper.
 *
 * React components call these functions instead of using fetch directly. The
 * shared request helper attaches cookies, sends JSON, and turns backend error
 * responses into normal JavaScript Error objects for the UI to display.
 */
import { AdminUser, AuthCapabilities, DashboardData, DashboardResourceName, FarmAccount, FarmInvitation, FeedbackReport, InvitationPreview, OfflineImageryStatus, SessionInfo, TractorProfile, UndoState, UsageEvent, UserMessage } from "./types";

// Vite exposes only variables prefixed with VITE_ to browser code. Local dev
// keeps the old localhost default, while hosted builds can point at a deployed API.
export const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:4000";

let csrfToken: string | null = null;

// All app requests currently expect JSON responses from the local API.
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set("Content-Type", "application/json");
  if (csrfToken && init?.method && !["GET", "HEAD", "OPTIONS"].includes(init.method.toUpperCase())) {
    headers.set("X-CSRF-Token", csrfToken);
  }

  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers,
    credentials: "include"
  });

  if (!response.ok) {
    const contentType = response.headers.get("content-type") ?? "";
    let message = `Request failed: ${response.status}`;

    if (contentType.includes("application/json")) {
      const payload = await response.json();
      if (typeof payload?.error === "string") {
        message = payload.error;
      } else if (Array.isArray(payload?.error) && payload.error.length > 0) {
        const messages = payload.error
          .map((item: { message?: unknown }) => (typeof item?.message === "string" ? item.message : null))
          .filter((item: string | null): item is string => Boolean(item));
        if (messages.length > 0) {
          message = messages.join(" ");
        }
      }
    }

    throw new Error(message);
  }

  const payload = await response.json();
  if (
    payload &&
    typeof payload === "object" &&
    "csrfToken" in payload &&
    typeof (payload as { csrfToken?: unknown }).csrfToken === "string"
  ) {
    csrfToken = (payload as { csrfToken: string }).csrfToken;
  }

  return payload;
}

async function download(path: string) {
  const response = await fetch(`${API_BASE}${path}`, {
    credentials: "include"
  });

  if (!response.ok) {
    const contentType = response.headers.get("content-type") ?? "";
    let message = `Request failed: ${response.status}`;
    if (contentType.includes("application/json")) {
      const payload = await response.json();
      if (typeof payload?.error === "string") {
        message = payload.error;
      }
    }
    throw new Error(message);
  }

  const disposition = response.headers.get("content-disposition") ?? "";
  const filenameMatch = disposition.match(/filename="?([^"]+)"?/i);
  return {
    blob: await response.blob(),
    filename: filenameMatch?.[1] ?? defaultBackupFilename()
  };
}

function defaultBackupFilename() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `loam-ledger-backup-${year}-${month}-${day}.xlsx`;
}

export const api = {
  getSession: () => request<SessionInfo>("/api/session"),
  getAuthCapabilities: () => request<AuthCapabilities>("/api/auth/capabilities"),
  login: (body: unknown) => request<SessionInfo>("/api/auth/login", { method: "POST", body: JSON.stringify(body) }),
  register: (body: unknown) => request<SessionInfo>("/api/auth/register", { method: "POST", body: JSON.stringify(body) }),
  forgotPassword: (body: unknown) => request<{ ok: boolean; developmentActionUrl?: string | null }>("/api/auth/forgot-password", { method: "POST", body: JSON.stringify(body) }),
  resendVerification: (body: unknown) => request<{ ok: boolean; developmentActionUrl?: string | null }>("/api/auth/resend-verification", { method: "POST", body: JSON.stringify(body) }),
  resetPassword: (body: unknown) => request<{ ok: boolean }>("/api/auth/reset-password", { method: "POST", body: JSON.stringify(body) }),
  inspectInvitation: (token: string) => request<InvitationPreview>(`/api/invitations/inspect?token=${encodeURIComponent(token)}`),
  acceptInvitation: (body: unknown) => request<SessionInfo>("/api/invitations/accept", { method: "POST", body: JSON.stringify(body) }),
  logout: () => request("/api/auth/logout", { method: "POST" }),
  changePassword: (body: unknown) => request<{ ok: boolean }>("/api/account/password", { method: "POST", body: JSON.stringify(body) }),
  getAdminUsers: () => request<AdminUser[]>("/api/admin/users"),
  deleteAdminUser: (id: number) => request<{ ok: boolean }>(`/api/admin/users/${id}`, { method: "DELETE" }),
  getAccounts: () => request<FarmAccount[]>("/api/accounts"),
  updateAccountRole: (id: number, role: string) => request<{ ok: boolean }>(`/api/accounts/${id}`, { method: "PATCH", body: JSON.stringify({ role }) }),
  removeAccountFromFarm: (id: number) => request<{ ok: boolean }>(`/api/accounts/${id}`, { method: "DELETE" }),
  getInvitations: () => request<FarmInvitation[]>("/api/invitations"),
  createInvitation: (body: unknown) => request<FarmInvitation>("/api/invitations", { method: "POST", body: JSON.stringify(body) }),
  cancelInvitation: (id: number) => request<{ ok: boolean }>(`/api/invitations/${id}`, { method: "DELETE" }),
  updateFarmSettings: (body: unknown) => request<{ ok: boolean }>("/api/farm/settings", { method: "PUT", body: JSON.stringify(body) }),
  createFeedback: (body: unknown) => request<{ id: number }>("/api/feedback", { method: "POST", body: JSON.stringify(body) }),
  getFeedbackReports: () => request<FeedbackReport[]>("/api/feedback"),
  replyToFeedbackReport: (id: number, body: unknown) => request<UserMessage>(`/api/feedback/${id}/replies`, { method: "POST", body: JSON.stringify(body) }),
  getMessages: () => request<UserMessage[]>("/api/messages"),
  markMessageRead: (id: number) => request<{ ok: boolean }>(`/api/messages/${id}/read`, { method: "POST" }),
  getUsagePreference: () => request<{ enabled: boolean }>("/api/usage/preference"),
  setUsagePreference: (enabled: boolean) => request<{ enabled: boolean }>("/api/usage/preference", {
    method: "PUT",
    body: JSON.stringify({ enabled })
  }),
  recordUsageEvent: (body: {
    eventType: "page_view" | "page_leave" | "feature_used";
    page: string;
    feature?: string;
    durationSeconds?: number;
  }) => request<{ ok: boolean; recorded: boolean }>("/api/usage/events", {
    method: "POST",
    body: JSON.stringify(body)
  }),
  getUsageEvents: (limit = 200) => request<{ events: UsageEvent[]; retentionDays: number }>(`/api/usage/events?limit=${encodeURIComponent(String(limit))}`),
  deleteUsageEvents: () => request<{ ok: boolean; deleted: number }>("/api/usage/events", { method: "DELETE" }),
  getUndoSnapshots: () => request<UndoState>("/api/undo"),
  undoLastChange: () => request<{ ok: boolean; label: string }>("/api/undo", { method: "POST" }),
  redoLastChange: () => request<{ ok: boolean; label: string }>("/api/redo", { method: "POST" }),
  getDashboard: (resources?: DashboardResourceName[]) => {
    const query = resources?.length
      ? `?resources=${encodeURIComponent(resources.join(","))}`
      : "";
    return request<Partial<DashboardData>>(`/api/dashboard${query}`);
  },
  exportSpreadsheet: () => download("/api/export/spreadsheet"),
  getOfflineImageryStatus: () => request<OfflineImageryStatus>("/api/offline-imagery/status"),
  createTaskFlow: (body: unknown) => request("/api/task-flows", { method: "POST", body: JSON.stringify(body) }),
  updateTaskFlow: (id: number, body: unknown) => request(`/api/task-flows/${id}`, { method: "PUT", body: JSON.stringify(body) }),
  copyTaskFlow: (id: number) => request(`/api/task-flows/${id}/copy`, { method: "POST" }),
  deleteTaskFlow: (id: number) => request(`/api/task-flows/${id}`, { method: "DELETE" }),
  getTractorProfiles: () => request<TractorProfile[]>("/api/tractor-profiles"),
  createTractorProfile: (body: unknown) => request<TractorProfile>("/api/tractor-profiles", { method: "POST", body: JSON.stringify(body) }),
  updateTractorProfile: (id: number, body: unknown) => request<TractorProfile>(`/api/tractor-profiles/${id}`, { method: "PUT", body: JSON.stringify(body) }),
  deleteTractorProfile: (id: number) => request<{ ok: boolean }>(`/api/tractor-profiles/${id}`, { method: "DELETE" }),
  createBedPreset: (body: unknown) => request("/api/bed-presets", { method: "POST", body: JSON.stringify(body) }),
  deleteBedPreset: (id: number) => request(`/api/bed-presets/${id}`, { method: "DELETE" }),
  createSeedItem: (body: unknown) => request<{ id: number; cropId: number; varietyId: number | null }>("/api/seed-items", { method: "POST", body: JSON.stringify(body) }),
  updateSeedItem: (id: number, body: unknown) => request<{ ok: boolean }>(`/api/seed-items/${id}`, { method: "PUT", body: JSON.stringify(body) }),
  archiveSeedItem: (id: number) => request<{ ok: boolean }>(`/api/seed-items/${id}`, { method: "DELETE" }),
  restoreSeedItem: (id: number) => request<{ ok: boolean }>(`/api/seed-items/${id}/restore`, { method: "POST" }),
  importSpreadsheet: (body: unknown) => request<{
    parsedRows: number;
    importedPlantings: number;
    skippedRows: number;
    incompleteRows: number;
    importedFields?: number;
    skippedDuplicateFields?: number;
    importedBlocks?: number;
    skippedDuplicateBlocks?: number;
    importedBeds?: number;
    skippedDuplicateBeds?: number;
    importedRecords?: number;
    importedVehicles?: number;
  }>("/api/import/spreadsheet", { method: "POST", body: JSON.stringify(body) }),
  createCoverCropName: (body: unknown) => request("/api/cover-crops", { method: "POST", body: JSON.stringify(body) }),
  createField: (body: unknown) => request("/api/fields", { method: "POST", body: JSON.stringify(body) }),
  updateField: (id: number, body: unknown) => request(`/api/fields/${id}`, { method: "PUT", body: JSON.stringify(body) }),
  deleteField: (id: number) => request(`/api/fields/${id}`, { method: "DELETE" }),
  createBlock: (body: unknown) => request("/api/blocks", { method: "POST", body: JSON.stringify(body) }),
  createBlockZone: (body: unknown) => request("/api/block-zones", { method: "POST", body: JSON.stringify(body) }),
  splitBlockZone: (blockId: number, body: unknown) => request(`/api/blocks/${blockId}/split-zone`, { method: "POST", body: JSON.stringify(body) }),
  updateBlockZone: (id: number, body: unknown) => request(`/api/block-zones/${id}`, { method: "PUT", body: JSON.stringify(body) }),
  updateCoverCropWork: (id: number, body: unknown) => request(`/api/block-zones/${id}/cover-crop-work`, { method: "PUT", body: JSON.stringify(body) }),
  deleteBlockZone: (id: number) => request(`/api/block-zones/${id}`, { method: "DELETE" }),
  generateBeds: (blockId: number, body: unknown) => request(`/api/blocks/${blockId}/generate-beds`, { method: "POST", body: JSON.stringify(body) }),
  updateBlockPlacementPlan: (blockId: number, body: unknown) => request(`/api/blocks/${blockId}/placement-plan`, { method: "PUT", body: JSON.stringify(body) }),
  updateBlock: (id: number, body: unknown) => request(`/api/blocks/${id}`, { method: "PUT", body: JSON.stringify(body) }),
  deleteBlock: (id: number) => request(`/api/blocks/${id}`, { method: "DELETE" }),
  createBed: (body: unknown) => request("/api/beds", { method: "POST", body: JSON.stringify(body) }),
  updateBed: (id: number, body: unknown) => request(`/api/beds/${id}`, { method: "PUT", body: JSON.stringify(body) }),
  deleteBed: (id: number) => request(`/api/beds/${id}`, { method: "DELETE" }),
  createPlanting: (body: unknown) => request("/api/plantings", { method: "POST", body: JSON.stringify(body) }),
  createPlantingWorkflow: (body: unknown) => request<{ id?: number; placementsCreated: number }>("/api/workflows/plantings", { method: "POST", body: JSON.stringify(body) }),
  updatePlanting: (id: number, body: unknown) => request(`/api/plantings/${id}`, { method: "PUT", body: JSON.stringify(body) }),
  deletePlanting: (id: number) => request(`/api/plantings/${id}`, { method: "DELETE" }),
  recordTask: (taskId: number, body: unknown) => request(`/api/tasks/${taskId}/record`, { method: "POST", body: JSON.stringify(body) }),
  recordUnplannedWork: (body: unknown) => request<{ ok: boolean }>("/api/work-events/unplanned", { method: "POST", body: JSON.stringify(body) }),
  addPlacement: (plantingId: number, body: unknown) => request(`/api/plantings/${plantingId}/placements`, { method: "POST", body: JSON.stringify(body) }),
  recordActual: (plantingId: number, body: unknown) => request(`/api/plantings/${plantingId}/actuals`, { method: "POST", body: JSON.stringify(body) }),
  createHarvest: (body: unknown) => request("/api/harvests", { method: "POST", body: JSON.stringify(body) })
};
