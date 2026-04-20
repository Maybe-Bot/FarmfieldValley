// Date strings may come from PostgreSQL as either YYYY-MM-DD or full ISO
// timestamps. Screens usually only need the date portion.
export function formatDate(value: string | null) {
  if (!value) {
    return "—";
  }

  if (value.includes("T")) {
    return value.split("T")[0];
  }

  return value;
}
