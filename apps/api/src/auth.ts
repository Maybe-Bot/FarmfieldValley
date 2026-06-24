/**
 * Authentication helpers for the local prototype.
 *
 * This file keeps password hashing, session-cookie handling, and "who is this
 * request from?" lookup in one place. The rest of the API uses AuthContext
 * instead of reading cookies or sessions directly.
 */
import crypto from "node:crypto";
import express from "express";
import { pool } from "./db";
import { config } from "./config";
import { FarmRole } from "./types";

export type AuthContext = {
  userId: number;
  username: string;
  displayName: string | null;
  farmId: number;
  farmName: string;
  role: FarmRole;
  isAdmin: boolean;
};

export type AuthenticatedRequest = express.Request & {
  auth?: AuthContext | null;
};

function parseCookies(header: string | undefined) {
  if (!header) {
    return new Map<string, string>();
  }

  return new Map(
    header
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const separatorIndex = part.indexOf("=");
        if (separatorIndex === -1) {
          return [part, ""];
        }
        return [part.slice(0, separatorIndex), decodeURIComponent(part.slice(separatorIndex + 1))];
      })
  );
}

// Passwords are stored as "scrypt:salt:hash" so the raw password is never saved.
export function hashPassword(password: string) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `scrypt:${salt}:${hash}`;
}

export function verifyPassword(password: string, storedHash: string) {
  const [scheme, salt, expectedHash] = storedHash.split(":");
  if (scheme !== "scrypt" || !salt || !expectedHash) {
    return false;
  }

  const actual = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(expectedHash, "hex");
  return expected.length === actual.length && crypto.timingSafeEqual(actual, expected);
}

export function createSessionToken() {
  return crypto.randomBytes(32).toString("base64url");
}

function sessionCookieAttributes(maxAgeSeconds: number) {
  return [
    "Path=/",
    "HttpOnly",
    `SameSite=${config.sessionCookieSameSite}`,
    `Max-Age=${maxAgeSeconds}`,
    config.sessionCookieSecure ? "Secure" : null
  ].filter(Boolean).join("; ");
}

export function setSessionCookie(res: express.Response, token: string) {
  res.setHeader(
    "Set-Cookie",
    `${config.sessionCookieName}=${encodeURIComponent(token)}; ${sessionCookieAttributes(config.sessionMaxAgeDays * 86400)}`
  );
}

export function clearSessionCookie(res: express.Response) {
  res.setHeader(
    "Set-Cookie",
    `${config.sessionCookieName}=; ${sessionCookieAttributes(0)}`
  );
}

export function readSessionToken(req: express.Request) {
  const cookies = parseCookies(req.headers.cookie);
  return cookies.get(config.sessionCookieName) ?? null;
}

export function csrfTokenForSession(sessionToken: string) {
  return crypto
    .createHmac("sha256", config.csrfSecret)
    .update(sessionToken)
    .digest("base64url");
}

export function csrfTokenForRequest(req: express.Request) {
  const sessionToken = readSessionToken(req);
  return sessionToken ? csrfTokenForSession(sessionToken) : null;
}

export const AUTH_CONTEXT_QUERY = `
  select
    session.user_id,
    app_user.username,
    app_user.display_name,
    session.farm_id,
    farm.name as farm_name,
    membership.role,
    app_user.is_admin
  from user_sessions session
  join app_users app_user on app_user.id = session.user_id
  join farm_memberships membership on membership.user_id = session.user_id and membership.farm_id = session.farm_id
  join farms farm on farm.id = session.farm_id
  where session.session_token = $1
    and session.expires_at > now()
    and app_user.is_active = true
  limit 1
`;

// Converts the session cookie into the user, farm, farm role, and admin flag.
export async function resolveAuthContext(req: express.Request) {
  const sessionToken = readSessionToken(req);
  if (!sessionToken) {
    return null;
  }

  const result = await pool.query<{
    user_id: number;
    username: string;
    display_name: string | null;
    farm_id: number;
    farm_name: string;
    role: FarmRole;
    is_admin: boolean;
  }>(AUTH_CONTEXT_QUERY, [sessionToken]);

  const row = result.rows[0];
  if (!row) {
    return null;
  }

  return {
    userId: row.user_id,
    username: row.username,
    displayName: row.display_name,
    farmId: row.farm_id,
    farmName: row.farm_name,
    role: row.role,
    isAdmin: row.is_admin
  } satisfies AuthContext;
}
