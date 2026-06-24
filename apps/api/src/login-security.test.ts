import test from "node:test";
import assert from "node:assert/strict";
import { hashPassword } from "./auth";
import {
  assessLoginCredentials,
  INVALID_LOGIN_ERROR,
  UNVERIFIED_EMAIL_LOGIN_ERROR
} from "./login-security";

test("bad password is rejected as a failed login", () => {
  const result = assessLoginCredentials(
    {
      password_hash: hashPassword("correct-password1"),
      is_active: true,
      email_verified_at: "2026-06-22T12:00:00Z"
    },
    "wrong-password1",
    true
  );

  assert.deepEqual(result, {
    allowed: false,
    status: 401,
    error: INVALID_LOGIN_ERROR,
    recordFailure: true
  });
});

test("valid password with unverified email is recorded as a failed login", () => {
  const result = assessLoginCredentials(
    {
      password_hash: hashPassword("correct-password1"),
      is_active: true,
      email_verified_at: null
    },
    "correct-password1",
    true
  );

  assert.deepEqual(result, {
    allowed: false,
    status: 403,
    error: UNVERIFIED_EMAIL_LOGIN_ERROR,
    recordFailure: true
  });
});
