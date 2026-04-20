/**
 * Tiny formatting/date helpers used by backend modules.
 *
 * Keep this file limited to generic utilities. Anything tied to farms, maps, or
 * tasks should live in a more specific module.
 */
export function toIsoDate(input: Date | string) {
  return new Date(input).toISOString().slice(0, 10);
}

export function addDays(isoDate: string, offset: number) {
  const next = new Date(`${isoDate}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + offset);
  return toIsoDate(next);
}

export function titleCase(input: string) {
  return input
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}
