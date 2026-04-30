import { FarmRole } from "./types";

// Shared account text/validation helpers used by both the login screen and
// in-app team account form. Keeping this in one place prevents the frontend
// from showing different password rules in different screens.
export function roleLabel(role: FarmRole) {
  return role === "planner" ? "planner" : "worker";
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
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(options.email.trim())) {
      return "Enter a valid email address.";
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
