import { Task } from "./types";

export type DistanceUnit = "m" | "ft";

export function dateInputValue(value: string | null | undefined) {
  if (!value) {
    return "";
  }

  return value.includes("T") ? value.split("T")[0] : value;
}

export function toNumericValue(value: number | string | null | undefined) {
  if (value == null) {
    return null;
  }

  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

export function formatLength(valueM: number | string | null, unit: DistanceUnit) {
  const numericValue = toNumericValue(valueM);
  if (numericValue == null) {
    return "—";
  }

  if (unit === "ft") {
    return `${(numericValue * 3.28084).toFixed(1)} ft`;
  }

  return `${numericValue.toFixed(1)} m`;
}

export function formatLengthInputValue(valueM: number | string | null, unit: DistanceUnit) {
  const numericValue = toNumericValue(valueM);
  if (numericValue == null) {
    return "";
  }

  if (unit === "ft") {
    return (numericValue * 3.28084).toFixed(2);
  }

  return numericValue.toFixed(2);
}

export function parseLengthInputValue(value: FormDataEntryValue | null, unit: DistanceUnit) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) {
    return null;
  }

  const numericValue = Number(raw);
  if (!Number.isFinite(numericValue)) {
    return null;
  }

  return unit === "ft" ? numericValue / 3.28084 : numericValue;
}

export function defaultSpacingExample(unit: DistanceUnit) {
  return unit === "ft" ? "11.8 in x 11.8 in" : "30 cm x 30 cm";
}

export function formatDisplayArea(valueSqM: number | string | null | undefined, unit: DistanceUnit) {
  const numericValue = toNumericValue(valueSqM);
  if (numericValue == null || numericValue <= 0) {
    return "—";
  }

  const acres = numericValue / 4046.8564224;
  if (acres >= 0.125) {
    return `${acres.toFixed(acres >= 10 ? 1 : 2)} ac`;
  }

  if (unit === "ft") {
    return `${Math.round(numericValue * 10.7639).toLocaleString()} sq ft`;
  }

  return `${Math.round(numericValue).toLocaleString()} sq m`;
}

export function formatDecimalInputValue(value: number) {
  if (!Number.isFinite(value)) {
    return "";
  }
  const fixed = value >= 100 ? value.toFixed(0) : value >= 10 ? value.toFixed(1) : value.toFixed(2);
  return fixed.replace(/\.0+$/, "").replace(/(\.\d*[1-9])0+$/, "$1");
}

export function formatSpacing(value: string | null, unit: DistanceUnit) {
  if (!value) {
    return "—";
  }

  if (unit === "m") {
    return value;
  }

  return value
    .replace(/(\d+(?:\.\d+)?)\s*cm\b/gi, (_match, amount) => `${(Number(amount) / 2.54).toFixed(1)} in`)
    .replace(/(\d+(?:\.\d+)?)\s*m\b/gi, (_match, amount) => `${(Number(amount) * 3.28084).toFixed(1)} ft`);
}

export function spacingUnitLabel(unit: DistanceUnit) {
  return unit === "ft" ? "in" : "cm";
}

export function spacingInputToMeters(value: string, unit: DistanceUnit) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue) || numericValue <= 0) {
    return null;
  }

  return unit === "ft" ? numericValue * 0.0254 : numericValue / 100;
}

export function spacingMetersToInput(valueM: number, unit: DistanceUnit) {
  return unit === "ft" ? valueM / 0.0254 : valueM * 100;
}

export function parseSpacingPairForUnit(value: string | null, unit: DistanceUnit) {
  if (!value) {
    return { inRow: "", betweenRows: "" };
  }

  const matches = [...value.matchAll(/(\d+(?:\.\d+)?)\s*(cm|m|in|ft)?/gi)];
  if (matches.length === 0) {
    return { inRow: "", betweenRows: "" };
  }

  const toMeters = (amount: string, rawUnit: string | undefined) => {
    const numericValue = Number(amount);
    if (!Number.isFinite(numericValue)) {
      return null;
    }

    const sourceUnit = rawUnit?.toLowerCase() ?? (unit === "ft" ? "in" : "cm");
    if (sourceUnit === "in") return numericValue * 0.0254;
    if (sourceUnit === "ft") return numericValue / 3.28084;
    if (sourceUnit === "m") return numericValue;
    return numericValue / 100;
  };

  const first = toMeters(matches[0][1], matches[0][2]);
  const second = toMeters(matches[1]?.[1] ?? matches[0][1], matches[1]?.[2] ?? matches[0][2]);

  return {
    inRow: first == null ? "" : spacingMetersToInput(first, unit).toFixed(unit === "ft" ? 1 : 0),
    betweenRows: second == null ? "" : spacingMetersToInput(second, unit).toFixed(unit === "ft" ? 1 : 0)
  };
}

export function formatSpacingPair(inRow: string, betweenRows: string, unit: DistanceUnit) {
  const label = spacingUnitLabel(unit);
  const first = inRow.trim();
  const second = betweenRows.trim() || first;
  if (!first) {
    return null;
  }

  return `${first} ${label} x ${second} ${label}`;
}

export function todayDateInputValue() {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

export function addDaysToDate(value: string, days: number) {
  const date = new Date(`${value}T12:00:00`);
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

export function startOfWeekDate(value: string) {
  const date = new Date(`${value}T12:00:00`);
  const day = date.getDay();
  const mondayOffset = day === 0 ? -6 : 1 - day;
  date.setDate(date.getDate() + mondayOffset);
  return date.toISOString().slice(0, 10);
}

export function formatWeekRange(startDate: string) {
  return `${startDate} to ${addDaysToDate(startDate, 6)}`;
}

export function dateDiffDays(startDate: string | null | undefined, endDate: string | null | undefined) {
  if (!startDate || !endDate) {
    return null;
  }

  const start = new Date(`${startDate.slice(0, 10)}T12:00:00Z`).getTime();
  const end = new Date(`${endDate.slice(0, 10)}T12:00:00Z`).getTime();
  if (Number.isNaN(start) || Number.isNaN(end)) {
    return null;
  }

  return Math.round((end - start) / 86400000);
}

export function formatTaskWeekTitle(weekStart: string) {
  const currentWeekStart = startOfWeekDate(todayDateInputValue());
  const daysFromCurrentWeek = dateDiffDays(currentWeekStart, weekStart) ?? 0;
  const weeksFromCurrentWeek = Math.round(daysFromCurrentWeek / 7);
  if (weeksFromCurrentWeek === 0) return "Tasks this week";
  if (weeksFromCurrentWeek === -1) return "Tasks last week";
  if (weeksFromCurrentWeek === 1) return "Tasks next week";
  if (weeksFromCurrentWeek < 0) return `Tasks ${Math.abs(weeksFromCurrentWeek)} weeks ago`;
  return `Tasks in ${weeksFromCurrentWeek} weeks`;
}

export function formatDateForInputHint(value: string | null) {
  if (!value) {
    return "the scheduled date";
  }

  const [year, month, day] = value.split("-");
  if (!year || !month || !day) {
    return value;
  }
  return `${month}/${day}/${year}`;
}

export function isDateInWeek(value: string | null, weekStart: string) {
  if (!value) {
    return false;
  }
  const weekEnd = addDaysToDate(weekStart, 6);
  return value >= weekStart && value <= weekEnd;
}

export function defaultTaskRecordDate(task: Pick<Task, "scheduledDate">) {
  const today = todayDateInputValue();
  if (!task.scheduledDate) {
    return today;
  }

  const scheduled = new Date(`${task.scheduledDate}T12:00:00`).getTime();
  const current = new Date(`${today}T12:00:00`).getTime();
  const daysAway = Math.round((scheduled - current) / 86400000);
  return Math.abs(daysAway) <= 28 ? today : task.scheduledDate;
}

export function isPlantingActionTask(taskType: string) {
  return taskType === "seed_in_tray" || taskType === "direct_seed" || taskType === "transplant";
}

export function isCurrentTaskCategory(taskType: string) {
  return ["seed_in_tray", "direct_seed", "till", "fertilizing_spraying", "bed_making", "transplant", "cultivation", "cleanup", "cover_crop"].includes(taskType);
}

export function taskNeedsRecordForm(taskType: string) {
  return ["seed_in_tray", "direct_seed", "bed_making", "transplant"].includes(taskType);
}
