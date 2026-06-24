/**
 * Frontend data shapes returned by the API.
 *
 * These types make the React code easier to understand and catch mismatches
 * between the backend response and the UI. When an API response changes, update
 * the matching type here.
 */
export type GeoJsonPolygon = {
  type: "Polygon";
  coordinates: number[][][];
};

export type FarmRole = "planner" | "worker";

export type GeoJsonPoint = {
  type: "Point";
  coordinates: number[];
};

export type PlannedUse = "beds" | "cover_crop" | null;

export type ZoneActualState =
  | "needs_cleanup"
  | "needs_amendment"
  | "needs_tillage"
  | "ready_for_bed_making"
  | "beds_made"
  | "partially_planted"
  | "fully_planted"
  | "cover_crop_established"
  | "finished";

export type Field = {
  id: number;
  farmId: number;
  farmName: string;
  name: string;
  notes: string | null;
  areaSqM: number;
  boundary: GeoJsonPolygon | null;
  centroid: GeoJsonPoint | null;
};

export type Block = {
  id: number;
  farmId: number;
  farmName: string;
  fieldId: number;
  fieldName: string;
  name: string;
  notes: string | null;
  bedStartEntranceSide: "start" | "end";
  areaSqM: number;
  boundary: GeoJsonPolygon | null;
  centroid: GeoJsonPoint | null;
};

export type Bed = {
  id: number;
  farmId: number;
  farmName: string;
  blockId: number;
  blockName: string;
  zoneId: number | null;
  zoneName: string | null;
  name: string;
  isPermanent: boolean;
  notes: string | null;
  x: number;
  y: number;
  width: number;
  height: number;
  bedLengthM: number;
  occupiedLengthM: number;
  source: string;
  direction: string | null;
  sequenceNo: number | null;
  bedPresetId: number | null;
  bedPresetName: string | null;
  areaSqM: number | null;
  geometrySource: string;
  geometryUpdatedAt: string;
  geometryNotes: string | null;
  boundary: GeoJsonPolygon | null;
};

export type CoverCropName = {
  id: number;
  farmId: number;
  name: string;
  notes: string | null;
};

export type BlockZone = {
  id: number;
  farmId: number;
  farmName: string;
  blockId: number;
  blockName: string;
  fieldId: number;
  fieldName: string;
  name: string;
  plannedUse: PlannedUse;
  actualState: ZoneActualState;
  coverCropNameId: number | null;
  coverCropName: string | null;
  plannedCoverCropSeedDate: string | null;
  plannedCoverCropTerminateDate: string | null;
  actualCoverCropSeedDate: string | null;
  actualCoverCropTerminateDate: string | null;
  notes: string | null;
  areaSqM: number;
  boundary: GeoJsonPolygon | null;
  centroid: GeoJsonPoint | null;
};

export type Planting = {
  id: number;
  farmId: number;
  cropId: number;
  varietyId: number | null;
  seedItemId: number | null;
  cropName: string;
  varietyName: string | null;
  seedName: string | null;
  title: string;
  status: string;
  intendedFieldId: number | null;
  intendedFieldName: string | null;
  intendedBlockId: number | null;
  intendedBlockName: string | null;
  intendedBedId: number | null;
  intendedBedName: string | null;
  taskFlowTemplateId: number | null;
  taskFlowTemplateName: string | null;
  spacing: string | null;
  plantCount: number | null;
  bedLengthUsedM: number | null;
  trayLocation: string | null;
  trayCount: number | null;
  cellsPerTray: number | null;
  daysToHarvest: number | null;
  fieldSpacingInRow: number | null;
  rowSpacing: number | null;
  rowsPerBed: number | null;
  deadAtFrost: boolean | null;
  bedCover: string | null;
  notes: string | null;
  plannedSowDate: string | null;
  plannedTransplantDate: string | null;
  expectedHarvestStart: string | null;
  expectedHarvestEnd: string | null;
  actualTraySeedingDate: string | null;
  actualDirectSeedingDate: string | null;
  actualTransplantDate: string | null;
  actualCultivationDate: string | null;
  actualHarvestDate: string | null;
  actualFinishDate: string | null;
};

export type Placement = {
  id: number;
  plantingId: number;
  bedId: number;
  bedName: string;
  plantCount: number | null;
  bedLengthUsedM: number | null;
  startLengthM: number;
  placementOrder: number | null;
  planSource: string;
  placedOn: string | null;
  locationDetail: string | null;
  notes: string | null;
  boundary: GeoJsonPolygon | null;
};

export type PlacementGap = {
  id: number;
  farmId: number;
  blockId: number;
  blockName: string;
  bedId: number;
  bedName: string;
  startLengthM: number;
  bedLengthUsedM: number;
  placementOrder: number;
  notes: string | null;
};

export type PlacementOverflow = {
  id: number;
  farmId: number;
  blockId: number;
  blockName: string;
  plantingId: number | null;
  plantingTitle: string | null;
  entryType: "planting" | "gap";
  bedLengthUsedM: number;
  plantCount: number | null;
  trayCount: number | null;
  placementOrder: number;
  notes: string | null;
};

export type FarmEvent = {
  id: number;
  farmId: number;
  eventDate: string;
  eventType: string;
  title: string;
  notes: string | null;
  metadata: Record<string, unknown>;
  fieldId: number | null;
  blockId: number | null;
  zoneId: number | null;
  bedId: number | null;
  bedName: string | null;
  plantingId: number | null;
  plantingTitle: string | null;
  placementId: number | null;
  taskId: number | null;
  boundary: GeoJsonPolygon | null;
};

export type Task = {
  id: number;
  farmId: number;
  plantingId: number | null;
  bedId: number | null;
  taskFlowNodeId: number | null;
  taskType: string;
  title: string;
  iconColor: string;
  iconSecondaryColor: string;
  tractorModel: string | null;
  tractorProfileId: number | null;
  status: string;
  anchor: string | null;
  offsetDays: number | null;
  dependsOnTaskIds: number[];
  scheduledDate: string | null;
  completedDate: string | null;
  notes: string | null;
  isAutoGenerated: boolean;
  plantingTitle: string | null;
  bedName: string | null;
};

export type HarvestRecord = {
  id: number;
  farmId: number;
  plantingId: number;
  bedId: number;
  harvestDate: string;
  quantity: number;
  unit: string;
  notes: string | null;
  plantingTitle: string;
  bedName: string;
};

export type FeedbackReport = {
  id: number;
  farmId: number | null;
  userId: number | null;
  username: string;
  displayName: string | null;
  page: string;
  comment: string | null;
  context: Record<string, unknown>;
  recentActivity: Array<Record<string, unknown>>;
  userAgent: string | null;
  createdAt: string;
  replyCount: number;
  lastReplyAt: string | null;
};

export type UserMessage = {
  id: number;
  farmId: number | null;
  senderUserId: number | null;
  senderUsername: string | null;
  senderDisplayName: string | null;
  recipientUserId: number;
  relatedFeedbackReportId: number | null;
  subject: string;
  body: string;
  readAt: string | null;
  createdAt: string;
};

export type UsageEvent = {
  id: number;
  eventType: string;
  page: string;
  occurredAt: string;
  details: Record<string, string | null>;
  createdAt: string;
};

export type UndoSnapshotSummary = {
  id: number;
  label: string;
  createdAt: string;
};

export type UndoState = {
  undo: UndoSnapshotSummary[];
  redo: UndoSnapshotSummary[];
};

export type Crop = { id: number; name: string };
export type Variety = { id: number; cropId: number; name: string };
export type SeedLot = {
  id: number;
  seedItemId: number;
  lotNumber: string;
  stockQuantity: number | null;
};
export type SeedItem = {
  id: number;
  farmId: number;
  cropId: number | null;
  varietyId: number | null;
  family: string | null;
  cropType: string;
  varietyName: string | null;
  breedName: string | null;
  supplier: string | null;
  catalogNumber: string | null;
  lotNumber: string | null;
  stockQuantity: number | null;
  lots: SeedLot[];
  daysToMaturity: number | null;
  usualSpacing: string | null;
  usualFieldSpacingInRow: number | null;
  usualRowSpacing: number | null;
  usualRowsPerBed: number | null;
  notes: string | null;
  archivedAt: string | null;
  displayName: string;
};
export type BedPreset = {
  id: number;
  farmId: number;
  name: string;
  bedWidthM: number;
  pathSpacingM: number;
  isRoad: boolean;
  notes: string | null;
};

export type TaskFlowTemplate = {
  id: number;
  farmId: number;
  cropId: number | null;
  cropName: string | null;
  name: string;
  notes: string | null;
  isDefault: boolean;
  sourceTaskFlowTemplateId: number | null;
};

export type TaskFlowNode = {
  id: number;
  flowTemplateId: number;
  nodeKey: string;
  taskType: string;
  label: string;
  anchor: string;
  offsetDays: number;
  iconColor: string;
  iconSecondaryColor: string;
  tractorModel: string | null;
  tractorProfileId: number | null;
  x: number;
  y: number;
  notes: string | null;
};

export type TractorProfile = {
  id: number;
  farmId: number;
  name: string;
  tractorModel: string;
  iconColor: string;
  iconSecondaryColor: string;
};

export type TaskFlowEdge = {
  id: number;
  flowTemplateId: number;
  fromNodeKey: string;
  toNodeKey: string;
  delayDays: number;
};

export type DashboardData = {
  farm: { id: number; name: string; notes: string | null; mapsPrivate: boolean } | null;
  fields: Field[];
  blocks: Block[];
  blockZones: BlockZone[];
  beds: Bed[];
  bedPresets: BedPreset[];
  coverCropNames: CoverCropName[];
  seedItems: SeedItem[];
  crops: Crop[];
  varieties: Variety[];
  taskFlowTemplates: TaskFlowTemplate[];
  taskFlowNodes: TaskFlowNode[];
  taskFlowEdges: TaskFlowEdge[];
  tractorProfiles: TractorProfile[];
  plantings: Planting[];
  placements: Placement[];
  placementGaps: PlacementGap[];
  placementOverflows: PlacementOverflow[];
  events: FarmEvent[];
  tasks: Task[];
  harvests: HarvestRecord[];
};

export type DashboardResourceName = keyof DashboardData;

export type OfflineImageryStatus = {
  available: boolean;
  generatedAt: string | null;
  sourceName: string;
  sourceUrl: string;
  minZoom: number;
  maxZoom: number;
  bufferMiles: number;
  fieldCount: number;
  tileCount: number;
  downloadedCount: number;
  skippedCount: number;
  missingCount: number;
  failedCount: number;
  contextMinZoom: number;
  contextMaxZoom: number;
  contextBufferMiles: number;
  detailMinZoom: number;
  detailMaxZoom: number;
  detailBufferMiles: number;
  bounds: {
    south: number;
    west: number;
    north: number;
    east: number;
  } | null;
};

export type SessionInfo =
  | {
      authenticated: false;
      verificationRequired?: boolean;
      email?: string;
      developmentActionUrl?: string | null;
    }
  | {
      authenticated: true;
      user: {
        id: number;
        username: string;
        displayName: string | null;
        farmId: number;
        farmName: string;
        role: FarmRole;
        isAdmin: boolean;
      };
      csrfToken: string;
    };

export type FarmAccount = {
  id: number;
  email?: string;
  username: string;
  displayName: string | null;
  role: FarmRole;
  createdAt: string;
};

export type FarmInvitation = {
  id: number;
  email: string;
  displayName: string | null;
  role: FarmRole;
  createdAt: string;
  expiresAt: string;
  developmentActionUrl?: string | null;
};

export type InvitationPreview = {
  email: string;
  displayName: string | null;
  role: FarmRole;
  farmName: string;
  existingAccount: boolean;
};

export type AuthCapabilities = {
  emailVerificationEnabled: boolean;
  developmentEmailLinks: boolean;
};

export type AdminUser = {
  id: number;
  username: string;
  displayName: string | null;
  isActive: boolean;
  isAdmin: boolean;
  createdAt: string;
  lastSessionAt: string | null;
  feedbackCount: number;
  memberships: Array<{
    farmId: number;
    farmName: string;
    role: FarmRole;
  }>;
};
