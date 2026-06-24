export const dashboardResourceNames = [
  "farm",
  "fields",
  "blocks",
  "blockZones",
  "beds",
  "bedPresets",
  "coverCropNames",
  "seedItems",
  "crops",
  "varieties",
  "taskFlowTemplates",
  "taskFlowNodes",
  "taskFlowEdges",
  "tractorProfiles",
  "plantings",
  "placements",
  "placementGaps",
  "placementOverflows",
  "events",
  "tasks",
  "harvests"
] as const;

export type DashboardResourceName = (typeof dashboardResourceNames)[number];

export function parseDashboardResources(value: unknown): Set<DashboardResourceName> | null {
  if (typeof value !== "string" || value.trim() === "") {
    return null;
  }

  const requested = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const invalid = requested.filter(
    (item) => !dashboardResourceNames.includes(item as DashboardResourceName)
  );
  if (invalid.length > 0) {
    throw new Error(`Unknown dashboard resource: ${invalid.join(", ")}`);
  }
  return new Set(requested as DashboardResourceName[]);
}

export function dashboardResourceRequested(
  requested: Set<DashboardResourceName> | null,
  resource: DashboardResourceName
) {
  return requested == null || requested.has(resource);
}

export async function loadDashboardResource<T>(
  requested: Set<DashboardResourceName> | null,
  resource: DashboardResourceName,
  load: () => Promise<T>
): Promise<T | null> {
  return dashboardResourceRequested(requested, resource) ? load() : null;
}

export function dashboardResponse(
  requested: Set<DashboardResourceName> | null,
  values: Record<DashboardResourceName, unknown>
) {
  if (requested == null) {
    return values;
  }
  return Object.fromEntries(
    [...requested].map((resource) => [resource, values[resource]])
  );
}
