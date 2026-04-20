import test from "node:test";
import assert from "node:assert/strict";
import { csrfTokenForSession, setSessionCookie } from "./auth";

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
  assert.match(cookie, /farmman_session=session-token/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
});
