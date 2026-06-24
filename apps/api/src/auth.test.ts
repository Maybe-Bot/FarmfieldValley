import test from "node:test";
import assert from "node:assert/strict";
import { AUTH_CONTEXT_QUERY, csrfTokenForSession, setSessionCookie } from "./auth";

test("csrfTokenForSession is stable for a session and changes with the session token", () => {
  const first = csrfTokenForSession("session-a");
  assert.equal(first, csrfTokenForSession("session-a"));
  assert.notEqual(first, csrfTokenForSession("session-b"));
});

test("setSessionCookie includes HttpOnly and SameSite attributes", () => {
  const headers = new Map<string, string>();
  setSessionCookie({
    setHeader(name: string, value: string) {
      headers.set(name, value);
      return this;
    }
  } as never, "session-token");

  const cookie = headers.get("Set-Cookie") ?? "";
  assert.match(cookie, /loam_ledger_session=session-token/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
});

test("auth lookup stays anchored to the session token and active expiry check", () => {
  const normalized = AUTH_CONTEXT_QUERY.trim().replace(/\s+/g, " ").toLowerCase();

  assert.match(normalized, /from user_sessions session/);
  assert.match(normalized, /where session\.session_token = \$1/);
  assert.match(normalized, /and session\.expires_at > now\(\)/);
  assert.match(normalized, /limit 1/);
});
