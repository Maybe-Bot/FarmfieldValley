import test from "node:test";
import assert from "node:assert/strict";
import { accountTokenHash, createAccountToken } from "./account-tokens";
import { accountActionUrl, verificationActionUrl } from "./email-delivery";

test("account tokens are random and only their stable hash needs to be stored", () => {
  const first = createAccountToken();
  const second = createAccountToken();
  assert.notEqual(first, second);
  assert.equal(accountTokenHash(first), accountTokenHash(first));
  assert.notEqual(accountTokenHash(first), first);
  assert.equal(accountTokenHash(first).length, 64);
});

test("account email links use configured public URLs and preserve the token", () => {
  const reset = new URL(accountActionUrl("/?reset-password=1", "reset-token"));
  assert.equal(reset.origin, "http://localhost:5173");
  assert.equal(reset.searchParams.get("reset-password"), "1");
  assert.equal(reset.searchParams.get("token"), "reset-token");

  const verification = new URL(verificationActionUrl("verify-token"));
  assert.equal(verification.origin, "http://localhost:4000");
  assert.equal(verification.pathname, "/api/auth/verify-email");
  assert.equal(verification.searchParams.get("token"), "verify-token");
});
