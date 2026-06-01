import { FarmRole } from "./types";

export const EMAIL_VERIFICATION_BYPASS_ADDRESS = "junk@trash.com";
const EMAIL_PATTERN = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;

// Shared account text/validation helpers used by both the login screen and
// in-app team account form. Keeping this in one place prevents the frontend
// from showing different password rules in different screens.
export function roleLabel(role: FarmRole) {
  return role === "planner" ? "planner" : "worker";
}

export function normalizeAccountEmail(email: string) {
  return email.trim().toLowerCase();
}

export function isEmailVerificationBypassAddress(email: string) {
  return normalizeAccountEmail(email) === EMAIL_VERIFICATION_BYPASS_ADDRESS;
}

export function isTightAccountEmail(email: string) {
  const normalized = normalizeAccountEmail(email);
  return normalized.length <= 200 && EMAIL_PATTERN.test(normalized) && !normalized.includes("..");
}

// Mirrors the backend account rules so users see helpful messages before submit.
export function validateAccountInputs(options: {
  farmName?: string;
  email?: string;
  username: string;
  password: string;
}) {
  if (options.farmName !== undefined && !options.farmName.trim()) {
    return "Farm name is required.";
  }
  if (options.email !== undefined) {
    if (!options.email.trim()) {
      return "Email is required.";
    }
    if (!isTightAccountEmail(options.email)) {
      return `Enter a valid email address. Use ${EMAIL_VERIFICATION_BYPASS_ADDRESS} only for testing.`;
    }
  }
  if (!options.username.trim()) {
    return "Username is required.";
  }
  if (options.username.trim().length < 3) {
    return "Username must be at least 3 characters.";
  }
  if (options.password.length < 8) {
    return "Password must be at least 8 characters.";
  }
  if (!/[A-Za-z]/.test(options.password)) {
    return "Password must include at least one letter.";
  }
  if (!/\d/.test(options.password)) {
    return "Password must include at least one number.";
  }
  return null;
}
