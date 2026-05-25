/**
 * Frontend API wrapper.
 *
 * React components call these functions instead of using fetch directly. The
 * shared request helper attaches cookies, sends JSON, and turns backend error
 * responses into normal JavaScript Error objects for the UI to display.
 */
import { AdminUser, DashboardData, FarmAccount, FeedbackReport, OfflineImageryStatus, SessionInfo, UndoState } from "./types";

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
    } else {
      const text = await response.text();
      if (text) {
        message = text;
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

export const api = {
  getSession: () => request<SessionInfo>("/api/session"),
  login: (body: unknown) => request<SessionInfo>("/api/auth/login", { method: "POST", body: JSON.stringify(body) }),
  register: (body: unknown) => request<SessionInfo>("/api/auth/register", { method: "POST", body: JSON.stringify(body) }),
  logout: () => request("/api/auth/logout", { method: "POST" }),
  getAdminUsers: () => request<AdminUser[]>("/api/admin/users"),
  deleteAdminUser: (id: number) => request<{ ok: boolean }>(`/api/admin/users/${id}`, { method: "DELETE" }),
  getAccounts: () => request<FarmAccount[]>("/api/accounts"),
  createAccount: (body: unknown) => request<FarmAccount>("/api/accounts", { method: "POST", body: JSON.stringify(body) }),
  updateFarmSettings: (body: unknown) => request<{ ok: boolean }>("/api/farm/settings", { method: "PUT", body: JSON.stringify(body) }),
  createFeedback: (body: unknown) => request<{ id: number }>("/api/feedback", { method: "POST", body: JSON.stringify(body) }),
  getFeedbackReports: () => request<FeedbackReport[]>("/api/feedback"),
  getUndoSnapshots: () => request<UndoState>("/api/undo"),
  undoLastChange: () => request<{ ok: boolean; label: string }>("/api/undo", { method: "POST" }),
  redoLastChange: () => request<{ ok: boolean; label: string }>("/api/redo", { method: "POST" }),
  getDashboard: () => request<DashboardData>("/api/dashboard"),
  getOfflineImageryStatus: () => request<OfflineImageryStatus>("/api/offline-imagery/status"),
  createTaskFlow: (body: unknown) => request("/api/task-flows", { method: "POST", body: JSON.stringify(body) }),
  updateTaskFlow: (id: number, body: unknown) => request(`/api/task-flows/${id}`, { method: "PUT", body: JSON.stringify(body) }),
  copyTaskFlow: (id: number) => request(`/api/task-flows/${id}/copy`, { method: "POST" }),
  deleteTaskFlow: (id: number) => request(`/api/task-flows/${id}`, { method: "DELETE" }),
  createTractorProfile: (body: unknown) => request<{ id: number }>("/api/tractor-profiles", { method: "POST", body: JSON.stringify(body) }),
  updateTractorProfile: (id: number, body: unknown) => request<{ ok: boolean }>(`/api/tractor-profiles/${id}`, { method: "PUT", body: JSON.stringify(body) }),
  deleteTractorProfile: (id: number) => request<{ ok: boolean }>(`/api/tractor-profiles/${id}`, { method: "DELETE" }),
  createBedPreset: (body: unknown) => request("/api/bed-presets", { method: "POST", body: JSON.stringify(body) }),
  deleteBedPreset: (id: number) => request(`/api/bed-presets/${id}`, { method: "DELETE" }),
  createSeedItem: (body: unknown) => request<{ id: number; cropId: number; varietyId: number | null }>("/api/seed-items", { method: "POST", body: JSON.stringify(body) }),
  updateSeedItem: (id: number, body: unknown) => request<{ ok: boolean }>(`/api/seed-items/${id}`, { method: "PUT", body: JSON.stringify(body) }),
  archiveSeedItem: (id: number) => request<{ ok: boolean }>(`/api/seed-items/${id}`, { method: "DELETE" }),
  restoreSeedItem: (id: number) => request<{ ok: boolean }>(`/api/seed-items/${id}/restore`, { method: "POST" }),
  importSpreadsheet: (body: unknown) => request<{ parsedRows: number; importedPlantings: number; skippedRows: number; incompleteRows: number }>("/api/import/spreadsheet", { method: "POST", body: JSON.stringify(body) }),
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
  addPlacement: (plantingId: number, body: unknown) => request(`/api/plantings/${plantingId}/placements`, { method: "POST", body: JSON.stringify(body) }),
  recordActual: (plantingId: number, body: unknown) => request(`/api/plantings/${plantingId}/actuals`, { method: "POST", body: JSON.stringify(body) }),
  createHarvest: (body: unknown) => request("/api/harvests", { method: "POST", body: JSON.stringify(body) })
};
