const EMAIL_PATTERN = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;

export function normalizeAccountEmail(email: string) {
  return email.trim().toLowerCase();
}

export function isTightAccountEmail(email: string) {
  const normalized = normalizeAccountEmail(email);
  return (
    normalized.length <= 200 &&
    EMAIL_PATTERN.test(normalized) &&
    !normalized.includes("..")
  );
}
