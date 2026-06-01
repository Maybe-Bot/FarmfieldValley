export const EMAIL_VERIFICATION_BYPASS_ADDRESS = "junk@trash.com";

const EMAIL_PATTERN = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;

export function normalizeAccountEmail(email: string) {
  return email.trim().toLowerCase();
}

export function isEmailVerificationBypassAddress(email: string) {
  return normalizeAccountEmail(email) === EMAIL_VERIFICATION_BYPASS_ADDRESS;
}

export function isTightAccountEmail(email: string) {
  const normalized = normalizeAccountEmail(email);
  return (
    normalized.length <= 200 &&
    EMAIL_PATTERN.test(normalized) &&
    !normalized.includes("..")
  );
}
