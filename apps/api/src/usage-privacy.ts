import { z } from "zod";

const safeLabel = /^[a-z0-9][a-z0-9-]{0,39}$/;

export const usageEventSchema = z.object({
  eventType: z.enum(["page_view", "page_leave", "feature_used"]),
  page: z.string().trim().toLowerCase().regex(safeLabel),
  feature: z.string().trim().toLowerCase().regex(safeLabel).optional(),
  durationSeconds: z.number().finite().min(0).max(24 * 60 * 60).optional()
}).strict();

export type SafeUsageEvent = {
  eventType: "page_view" | "page_leave" | "feature_used";
  page: string;
  durationBucket: string | null;
  details: Record<string, string>;
};

function durationBucket(seconds: number | undefined) {
  if (seconds == null) return null;
  if (seconds < 10) return "under_10_seconds";
  if (seconds < 60) return "10_to_59_seconds";
  if (seconds < 300) return "1_to_4_minutes";
  if (seconds < 1800) return "5_to_29_minutes";
  return "30_minutes_or_more";
}

export function sanitizeUsageEvent(input: unknown): SafeUsageEvent {
  const body = usageEventSchema.parse(input);
  return {
    eventType: body.eventType,
    page: body.page,
    durationBucket: durationBucket(body.durationSeconds),
    details: body.feature ? { feature: body.feature } : {}
  };
}
