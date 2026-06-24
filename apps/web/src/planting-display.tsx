import { ReactNode } from "react";
import { divIcon } from "leaflet";
import { Planting, PlannedUse, ZoneActualState, Task } from "./types";
import { todayDateInputValue } from "./unit-utils";

export type PlantingMapColor = {
  hue: number;
  stroke: string;
  fill: string;
  label: string;
};

export type PlantingReviewSeverity = "major" | "minor";

export type PlantingReviewInfo = {
  severity: PlantingReviewSeverity | null;
  majorFields: Set<string>;
  minorFields: Set<string>;
  majorIssues: string[];
  minorIssues: string[];
};

export type PlantingPlanningInput = "initial" | "plantCount" | "bedLengthUsed" | "trayCount" | "cellsPerTray" | "seedCellCount" | "expectedTrayPlants" | "germinationRate" | "spacing" | "rowsPerBed" | "bed";
export type PlantingDateInput = "initial" | "plannedSowDate" | "plannedTransplantDate" | "daysToHarvest" | "expectedHarvestStart" | "expectedHarvestEnd";

export function summarizeTitles(titles: string[]) {
  const uniqueTitles = [...new Set(titles.filter(Boolean))];
  if (uniqueTitles.length === 0) {
    return "";
  }

  if (uniqueTitles.length <= 2) {
    return uniqueTitles.join(" • ");
  }

  return `${uniqueTitles[0]} +${uniqueTitles.length - 1}`;
}

export function readableMapLabelAngle(bearing: number) {
  if (!Number.isFinite(bearing)) {
    return 0;
  }
  let angle = ((bearing % 180) + 180) % 180;
  if (angle > 90) {
    angle -= 180;
  }
  return angle;
}

export function hslToHex(hue: number, saturation: number, lightness: number) {
  const s = saturation / 100;
  const l = lightness / 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] = hue < 60
    ? [c, x, 0]
    : hue < 120
      ? [x, c, 0]
      : hue < 180
        ? [0, c, x]
        : hue < 240
          ? [0, x, c]
          : hue < 300
            ? [x, 0, c]
            : [c, 0, x];
  return `#${[r, g, b].map((channel) => Math.round((channel + m) * 255).toString(16).padStart(2, "0")).join("")}`;
}

export function plantingMapColor(index: number): PlantingMapColor {
  const hue = (136 + index * 155) % 360;
  const stroke = hslToHex(hue, 60, 24);
  const fill = hslToHex(hue, 58, 42);
  return {
    hue,
    stroke,
    fill,
    label: stroke
  };
}

export function plantingMapColorForOrder(order: number | string | null | undefined) {
  const numericOrder = Number(order);
  const zeroBasedOrder = Number.isFinite(numericOrder) ? Math.max(0, Math.round(numericOrder) - 1) : 0;
  return plantingMapColor(zeroBasedOrder);
}

export function colorizeBlockPlacementRows<T extends { blockId: number; placementOrder: number; color: PlantingMapColor }>(rows: T[]) {
  const rowKeysByBlock = new Map<number, Array<{ key: number; order: number }>>();
  for (const row of rows) {
    const current = rowKeysByBlock.get(row.blockId) ?? [];
    if (!current.some((item) => item.key === row.placementOrder)) {
      current.push({ key: row.placementOrder, order: row.placementOrder });
      rowKeysByBlock.set(row.blockId, current);
    }
  }

  const colorIndexByBlockRow = new Map<string, number>();
  for (const [blockId, rowKeys] of rowKeysByBlock) {
    rowKeys
      .sort((left, right) => left.order - right.order)
      .forEach((rowKey, index) => {
        colorIndexByBlockRow.set(`${blockId}:${rowKey.key}`, index);
      });
  }

  return rows.map((row) => ({
    ...row,
    color: plantingMapColor(colorIndexByBlockRow.get(`${row.blockId}:${row.placementOrder}`) ?? 0)
  }));
}

export function plantingOverlayStyleForColor(color: PlantingMapColor, extraClassName?: string) {
  return {
    color: color.stroke,
    fillColor: color.fill,
    fillOpacity: 0.44,
    weight: 2,
    className: ["map-plan-path", extraClassName].filter(Boolean).join(" "),
    bubblingMouseEvents: false
  };
}

export function plantingLabelIcon(label: string, bearing: number, tone: "planned" | "actual", color: string) {
  const safeLabel = label.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;"
  }[char] ?? char));
  return divIcon({
    className: "planting-map-label-icon",
    iconSize: [1, 1],
    html: `<span class="planting-map-label planting-map-label-${tone}" style="--label-angle: ${readableMapLabelAngle(bearing)}deg; --label-color: ${color}">${safeLabel}</span>`
  });
}

function sentenceCase(input: string) {
  return input.replaceAll("_", " ");
}

export function formatTaskTypeLabel(taskType: string) {
  const labels: Record<string, string> = {
    seed_in_tray: "seed in tray",
    direct_seed: "direct seed",
    till: "till",
    fertilizing_spraying: "fertilizing / spraying",
    bed_making: "bed making",
    transplant: "transplanting",
    cultivation: "cultivation",
    cleanup: "cleanup",
    cover_crop: "covercrop"
  };
  return labels[taskType] ?? `stale: ${sentenceCase(taskType)}`;
}

export function formatTaskAnchorLabel(anchor: string) {
  if (anchor.startsWith("after:")) {
    return `after ${anchor.slice("after:".length).split(",").filter(Boolean).join(", ")}`;
  }

  const labels: Record<string, string> = {
    planned_sow: "seeding date"
  };
  return labels[anchor] ?? `stale: ${sentenceCase(anchor)}`;
}

export function formatPlannedUseLabel(value: PlannedUse) {
  if (value == null) {
    return "none assigned";
  }
  return value === "cover_crop" ? "cover crop" : value.replaceAll("_", " ");
}

export function formatZoneActualStateLabel(value: ZoneActualState) {
  return value.replaceAll("_", " ");
}

export function mapSaveErrorMessage(error: unknown, itemLabel: string) {
  const message = error instanceof Error ? error.message : "Save failed.";
  if (message.toLowerCase().includes("polygon is not valid")) {
    return `Could not save ${itemLabel}: the outline crossed itself or has a bad shape. Click Cancel, then draw the outline again without crossing lines.`;
  }
  return `Could not save ${itemLabel}: ${message}`;
}

export function taskIconColor(taskType: string) {
  if (!["seed_in_tray", "direct_seed", "till", "fertilizing_spraying", "bed_making", "transplant", "cultivation", "cleanup", "cover_crop"].includes(taskType)) return "#b42318";
  if (taskType === "cultivation") return "#d98c2b";
  if (taskType === "transplant") return "#4f9b58";
  if (taskType === "direct_seed" || taskType === "seed_in_tray") return "#7c9f35";
  if (taskType === "bed_making" || taskType === "till") return "#8b6f43";
  if (taskType === "fertilizing_spraying") return "#5f8f4f";
  if (taskType === "cleanup" || taskType === "cover_crop") return "#6d7f45";
  return "#4f84aa";
}

export function taskColor(task: Pick<Task, "taskType" | "iconColor">) {
  return task.iconColor || taskIconColor(task.taskType);
}

export function latestDateIndexOnOrBefore(dates: string[], targetDate: string) {
  let index = 0;
  for (let currentIndex = 0; currentIndex < dates.length; currentIndex += 1) {
    if (dates[currentIndex] <= targetDate) {
      index = currentIndex;
    }
  }
  return index;
}

export function addDaysToDateString(value: string | null, days: number) {
  if (!value) {
    return null;
  }

  const date = new Date(`${value.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function daysBetweenDateStrings(startDate: string | null, endDate: string | null) {
  if (!startDate || !endDate) {
    return null;
  }

  const start = new Date(`${startDate.slice(0, 10)}T00:00:00Z`);
  const end = new Date(`${endDate.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return null;
  }

  const days = Math.round((end.getTime() - start.getTime()) / 86400000);
  return days > 0 ? days : null;
}

export function plantingGroundStartDate(planting: Planting) {
  return planting.actualTransplantDate
    ?? planting.actualDirectSeedingDate
    ?? planting.plannedTransplantDate
    ?? planting.plannedSowDate;
}

export function plantingGroundEndDate(planting: Planting) {
  return planting.actualFinishDate
    ?? planting.actualHarvestDate
    ?? planting.expectedHarvestEnd
    ?? planting.expectedHarvestStart
    ?? addDaysToDateString(plantingGroundStartDate(planting), 120);
}

export function plantingPlanYear(planting: Planting) {
  const date = planting.plannedSowDate
    ?? planting.plannedTransplantDate
    ?? planting.expectedHarvestStart
    ?? planting.actualTraySeedingDate
    ?? planting.actualDirectSeedingDate
    ?? todayDateInputValue();
  return Number(date.slice(0, 4));
}

export function isPlantingInGroundOnDate(planting: Planting, date: string) {
  const startDate = plantingGroundStartDate(planting);
  if (!startDate || startDate > date) {
    return false;
  }

  const endDate = plantingGroundEndDate(planting);
  return !endDate || endDate >= date;
}

export function plantingCropVarietyLabel(planting: Planting) {
  if (planting.seedName) {
    return planting.seedName;
  }
  return planting.varietyName ? `${planting.cropName} / ${planting.varietyName}` : planting.cropName;
}

export function issueListFromNotes(notes: string | null | undefined, prefix: string) {
  const line = (notes ?? "").split(/\r?\n/).find((item) => item.startsWith(prefix));
  if (!line) {
    return [];
  }
  return line
    .slice(prefix.length)
    .replace(/\.$/, "")
    .split(";")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function fieldsForImportIssue(issue: string) {
  const lower = issue.toLowerCase();
  if (lower.includes("plant count or bed length")) return ["plantCount", "bedLengthUsed"];
  if (lower.includes("crop")) return ["crop"];
  if (lower.includes("variety")) return ["variety"];
  if (lower.includes("start date")) return ["plannedSowDate"];
  if (lower.includes("bed length")) return ["bedLengthUsed"];
  if (lower.includes("plant count")) return ["plantCount"];
  if (lower.includes("field/block")) return ["field", "block"];
  if (lower.includes("rows per bed")) return ["rowsPerBed"];
  if (lower.includes("field spacing") || lower.includes("row spacing")) return ["spacing"];
  if (lower.includes("field")) return ["field"];
  if (lower.includes("block")) return ["block"];
  if (lower.includes("bed cover")) return ["bedCover"];
  if (lower.includes("bed")) return ["bed"];
  if (lower.includes("transplant date")) return ["plannedTransplantDate"];
  if (lower.includes("days to harvest")) return ["daysToHarvest"];
  if (lower.includes("catalog")) return ["notes"];
  return ["notes"];
}

export function plantingFieldStillNeedsReview(planting: Planting, fieldName: string) {
  if (fieldName === "crop") return planting.cropName === "Needs crop";
  if (fieldName === "title") return planting.title.startsWith("Needs completion - ");
  if (fieldName === "variety") return planting.varietyName == null;
  if (fieldName === "plannedSowDate") return planting.plannedSowDate == null;
  if (fieldName === "plannedTransplantDate") return planting.plannedTransplantDate == null;
  if (fieldName === "expectedHarvestStart") return planting.expectedHarvestStart == null;
  if (fieldName === "expectedHarvestEnd") return planting.expectedHarvestEnd == null;
  if (fieldName === "plantCount") return planting.plantCount == null || planting.plantCount === 1;
  if (fieldName === "bedLengthUsed") return planting.bedLengthUsedM == null;
  if (fieldName === "field") return planting.intendedFieldId == null;
  if (fieldName === "block") return planting.intendedBlockId == null;
  if (fieldName === "bed") return planting.intendedBedId == null;
  if (fieldName === "spacing") return planting.spacing == null;
  if (fieldName === "rowsPerBed") return planting.rowsPerBed == null;
  if (fieldName === "daysToHarvest") return planting.daysToHarvest == null;
  if (fieldName === "bedCover") return planting.bedCover == null;
  return true;
}

export function plantingReviewInfo(planting: Planting): PlantingReviewInfo {
  const majorIssues = issueListFromNotes(planting.notes, "Needs manual completion: ");
  const minorIssues = issueListFromNotes(planting.notes, "Optional fields to review: ");
  const majorFields = new Set<string>();
  const minorFields = new Set<string>();

  for (const issue of majorIssues) {
    fieldsForImportIssue(issue).forEach((field) => {
      if (plantingFieldStillNeedsReview(planting, field)) {
        majorFields.add(field);
      }
    });
  }
  for (const issue of minorIssues) {
    fieldsForImportIssue(issue).forEach((field) => {
      if (plantingFieldStillNeedsReview(planting, field)) {
        minorFields.add(field);
      }
    });
  }

  if (planting.title.startsWith("Needs completion - ")) {
    majorFields.add("title");
  }
  if (planting.cropName === "Needs crop") {
    majorFields.add("crop");
  }

  return {
    severity: majorFields.size > 0 ? "major" : minorFields.size > 0 ? "minor" : null,
    majorFields,
    minorFields,
    majorIssues,
    minorIssues
  };
}

export function PlantingReviewBadge({ severity, title }: { severity: PlantingReviewSeverity; title: string }) {
  return <span className={`review-square review-square-${severity}`} title={title} aria-label={title} />;
}

export function PlantingReviewMarker({ review }: { review: PlantingReviewInfo }) {
  if (review.severity === "major") {
    return <PlantingReviewBadge severity="major" title={`Major spreadsheet issue: ${review.majorIssues.join("; ") || "review needed"}`} />;
  }
  if (review.severity === "minor") {
    return <PlantingReviewBadge severity="minor" title={`Optional spreadsheet info missing: ${review.minorIssues.join("; ") || "review suggested"}`} />;
  }
  return null;
}

export function fieldReviewSeverity(review: PlantingReviewInfo, fieldName: string): PlantingReviewSeverity | null {
  if (review.majorFields.has(fieldName)) return "major";
  if (review.minorFields.has(fieldName)) return "minor";
  return null;
}

export function FieldLabel({
  children,
  review,
  fieldName,
  severityOverride
}: {
  children: ReactNode;
  review: PlantingReviewInfo;
  fieldName: string;
  severityOverride?: PlantingReviewSeverity | null;
}) {
  const severity = severityOverride ?? fieldReviewSeverity(review, fieldName);
  return (
    <span className="field-label-with-review">
      {children}
      {severity && (
        <PlantingReviewBadge
          severity={severity}
          title={severity === "major" ? "Important spreadsheet value needs correction" : "Optional spreadsheet value is missing"}
        />
      )}
    </span>
  );
}

export function DetailTerm({ review, fieldName, children }: { review: PlantingReviewInfo; fieldName: string; children: ReactNode }) {
  const severity = fieldReviewSeverity(review, fieldName);
  return (
    <dt className="detail-term-with-review">
      <span>{children}</span>
      {severity && (
        <PlantingReviewBadge
          severity={severity}
          title={severity === "major" ? "Important spreadsheet value needs correction" : "Optional spreadsheet value is missing"}
        />
      )}
    </dt>
  );
}

export function mapObjectLabel(name: string) {
  const cleaned = name
    .trim()
    .replace(/\s+imported current area$/i, "")
    .replace(/\s+area\s+\d+$/i, "")
    .replace(/\s+area$/i, "")
    .replace(/^area\s+\d+$/i, "")
    .trim();

  return cleaned || name.replace(/\barea\b/gi, "").replace(/\s+/g, " ").trim();
}

export function defaultZoneName(options: {
  plannedUse: PlannedUse;
  explicitName: string;
  coverCropLabel?: string | null;
  existingCount: number;
}) {
  const explicit = options.explicitName.trim();
  if (explicit) {
    return explicit;
  }

  const nextIndex = options.existingCount + 1;
  if (options.plannedUse === "cover_crop") {
    const label = options.coverCropLabel?.trim() || "Cover crop";
    return `${label} area ${nextIndex}`;
  }
  return `Area ${nextIndex}`;
}

export function fieldStyle(isSelected: boolean) {
  return {
    color: isSelected ? "#fff5d0" : "#234d35",
    weight: isSelected ? 4 : 2,
    fillColor: "#4f8b5c",
    fillOpacity: isSelected ? 0.26 : 0.18,
    bubblingMouseEvents: false
  };
}

export function blockStyle(isSelected: boolean) {
  return {
    color: isSelected ? "#fff2d2" : "#9a6429",
    weight: isSelected ? 4 : 2,
    fillColor: "#d5a252",
    fillOpacity: isSelected ? 0.32 : 0.22,
    dashArray: isSelected ? undefined : "6 4",
    bubblingMouseEvents: false
  };
}

export function zoneStyle(plannedUse: PlannedUse, isSelected: boolean) {
  const palette = plannedUse === "beds"
    ? { color: "#2f6b45", fill: "#76a86a" }
    : plannedUse === "cover_crop"
      ? { color: "#6f8f2c", fill: "#9fbd4c" }
      : { color: "#7b6f54", fill: "#b7a27b" };

  return {
    color: isSelected ? "#fff5d0" : palette.color,
    weight: isSelected ? 4 : 2,
    fillColor: isSelected ? "#fff0c2" : palette.fill,
    fillOpacity: isSelected ? 0.4 : 0.2
  };
}

export function bedStyle(isSelected: boolean, isRoad: boolean) {
  if (isRoad) {
    return {
      color: isSelected ? "#fff4cf" : "#806a4b",
      weight: isSelected ? 3 : 2,
      fillColor: "#b7a27b",
      fillOpacity: isSelected ? 0.58 : 0.42,
      dashArray: "6 4",
      bubblingMouseEvents: false
    };
  }

  return {
    color: isSelected ? "#eff7ff" : "#7aa7c7",
    weight: isSelected ? 2 : 1,
    fillColor: "#bcd8e8",
    fillOpacity: isSelected ? 0.5 : 0.34,
    bubblingMouseEvents: false
  };
}

export function plannedOverlayStyle() {
  return {
    color: "#2f84a7",
    weight: 3,
    fillColor: "#bde9f4",
    fillOpacity: 0.14,
    dashArray: "3 7",
    className: "map-plan-path",
    bubblingMouseEvents: false
  };
}

export function placementOverlayStyle() {
  return {
    color: "#2e7d45",
    weight: 3,
    fillColor: "#70b45c",
    fillOpacity: 0.42,
    className: "map-actual-path",
    bubblingMouseEvents: false
  };
}
