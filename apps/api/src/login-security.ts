import { verifyPassword } from "./auth";

export const INVALID_LOGIN_ERROR = "Invalid username or password";
export const UNVERIFIED_EMAIL_LOGIN_ERROR = "Check your email to verify this account before logging in.";

export type LoginUserRecord = {
  password_hash: string;
  is_active: boolean;
  email_verified_at: string | null;
};

export type LoginCredentialAssessment =
  | { allowed: true }
  | { allowed: false; status: 401 | 403; error: string; recordFailure: true };

export function assessLoginCredentials(
  user: LoginUserRecord | null | undefined,
  password: string,
  requireEmailVerification: boolean
): LoginCredentialAssessment {
  if (!user || !user.is_active || !verifyPassword(password, user.password_hash)) {
    return {
      allowed: false,
      status: 401,
      error: INVALID_LOGIN_ERROR,
      recordFailure: true
    };
  }

  if (requireEmailVerification && !user.email_verified_at) {
    return {
      allowed: false,
      status: 403,
      error: UNVERIFIED_EMAIL_LOGIN_ERROR,
      recordFailure: true
    };
  }

  return { allowed: true };
}
