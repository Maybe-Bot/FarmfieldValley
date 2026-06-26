import test from "node:test";
import assert from "node:assert/strict";
import { accountUniqueViolationMessage } from "./account-unique-errors";

test("accountUniqueViolationMessage names active email conflicts", () => {
  assert.equal(
    accountUniqueViolationMessage({ code: "23505", constraint: "app_users_active_email_lower_unique_idx" }),
    "That email is already used by an active account. Delete that active account first, or use a different email."
  );
});

test("accountUniqueViolationMessage names username conflicts", () => {
  assert.equal(
    accountUniqueViolationMessage({ code: "23505", constraint: "app_users_username_key" }),
    "That username is already taken. Choose a new username."
  );
});

test("accountUniqueViolationMessage ignores non-unique errors", () => {
  assert.equal(accountUniqueViolationMessage({ code: "23503" }), null);
});
