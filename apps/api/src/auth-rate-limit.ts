import express from "express";
import crypto from "node:crypto";
import { pool } from "./db";

export const LOGIN_ATTEMPT_LIMIT = {
  limit: 20,
  windowMs: 15 * 60 * 1000,
  message: "Too many login attempts. Try again later."
} as const;

export const REGISTER_ATTEMPT_LIMIT = {
  limit: 8,
  windowMs: 60 * 60 * 1000,
  message: "Too many account creation attempts. Try again later."
} as const;

export const LOGIN_FAILURE_LOCKOUT = {
  failureLimit: 10,
  failureWindowMs: 15 * 60 * 1000,
  lockoutMs: 30 * 60 * 1000
} as const;

export type RateLimitResult = {
  allowed: boolean;
  retryAfterSeconds: number;
};

export interface AuthRateLimitStore {
  consumeFixedWindow(
    key: string,
    limit: number,
    windowMs: number,
    now: Date
  ): Promise<{ allowed: boolean; resetAt: Date }>;
  loginLockoutStatus(key: string, now: Date): Promise<{ lockedUntil: Date | null }>;
  recordLoginFailure(
    key: string,
    options: typeof LOGIN_FAILURE_LOCKOUT,
    now: Date
  ): Promise<void>;
  clearLoginFailures(key: string): Promise<void>;
}

function hashKey(key: string) {
  return crypto.createHash("sha256").update(key).digest("hex");
}

let lastExpirySweep = 0;

export class PostgresAuthRateLimitStore implements AuthRateLimitStore {
  private pruneExpiredRows(now: Date) {
    if (now.getTime() - lastExpirySweep < 60 * 60 * 1000) return;
    lastExpirySweep = now.getTime();
    void Promise.all([
      pool.query("delete from auth_rate_limits where expires_at <= $1", [now.toISOString()]),
      pool.query(
        `delete from auth_login_lockouts
         where failure_window_expires_at <= $1
           and (locked_until is null or locked_until <= $1)`,
        [now.toISOString()]
      )
    ]).catch((error) => console.error("Auth rate-limit expiry sweep failed", error));
  }

  async consumeFixedWindow(key: string, limit: number, windowMs: number, now: Date) {
    this.pruneExpiredRows(now);
    const result = await pool.query<{ allowed: boolean; reset_at: Date }>(
      `
        insert into auth_rate_limits (
          key_hash,
          window_started_at,
          attempt_count,
          expires_at
        )
        values ($1, $2, 1, $2::timestamptz + ($3::bigint * interval '1 millisecond'))
        on conflict (key_hash)
        do update set
          window_started_at = case
            when auth_rate_limits.expires_at <= $2 then $2
            else auth_rate_limits.window_started_at
          end,
          attempt_count = case
            when auth_rate_limits.expires_at <= $2 then 1
            else least(auth_rate_limits.attempt_count + 1, $4 + 1)
          end,
          expires_at = case
            when auth_rate_limits.expires_at <= $2
              then $2::timestamptz + ($3::bigint * interval '1 millisecond')
            else auth_rate_limits.expires_at
          end
        returning attempt_count <= $4 as allowed, expires_at as reset_at
      `,
      [hashKey(key), now.toISOString(), windowMs, limit]
    );
    const row = result.rows[0];
    return {
      allowed: row?.allowed === true,
      resetAt: new Date(row?.reset_at ?? now)
    };
  }

  async loginLockoutStatus(key: string, now: Date) {
    const result = await pool.query<{ locked_until: Date | null }>(
      `
        select locked_until
        from auth_login_lockouts
        where key_hash = $1
          and locked_until > $2
      `,
      [hashKey(key), now.toISOString()]
    );
    const lockedUntil = result.rows[0]?.locked_until;
    return { lockedUntil: lockedUntil ? new Date(lockedUntil) : null };
  }

  async recordLoginFailure(key: string, options: typeof LOGIN_FAILURE_LOCKOUT, now: Date) {
    this.pruneExpiredRows(now);
    await pool.query(
      `
        insert into auth_login_lockouts (
          key_hash,
          failure_count,
          failure_window_expires_at,
          locked_until
        )
        values (
          $1,
          1,
          $2::timestamptz + ($3::bigint * interval '1 millisecond'),
          null
        )
        on conflict (key_hash)
        do update set
          failure_count = case
            when auth_login_lockouts.failure_window_expires_at <= $2 then 1
            else auth_login_lockouts.failure_count + 1
          end,
          failure_window_expires_at = case
            when auth_login_lockouts.failure_window_expires_at <= $2
              then $2::timestamptz + ($3::bigint * interval '1 millisecond')
            else auth_login_lockouts.failure_window_expires_at
          end,
          locked_until = case
            when (
              case
                when auth_login_lockouts.failure_window_expires_at <= $2 then 1
                else auth_login_lockouts.failure_count + 1
              end
            ) >= $4
              then greatest(
                coalesce(auth_login_lockouts.locked_until, $2),
                $2::timestamptz + ($5::bigint * interval '1 millisecond')
              )
            when auth_login_lockouts.locked_until <= $2 then null
            else auth_login_lockouts.locked_until
          end
      `,
      [
        hashKey(key),
        now.toISOString(),
        options.failureWindowMs,
        options.failureLimit,
        options.lockoutMs
      ]
    );
  }

  async clearLoginFailures(key: string) {
    await pool.query("delete from auth_login_lockouts where key_hash = $1", [hashKey(key)]);
  }
}

export class AuthRateLimitService {
  constructor(
    private readonly store: AuthRateLimitStore,
    private readonly now: () => Date = () => new Date()
  ) {}

  async consume(key: string, options: { limit: number; windowMs: number }): Promise<RateLimitResult> {
    const now = this.now();
    const result = await this.store.consumeFixedWindow(key, options.limit, options.windowMs, now);
    return {
      allowed: result.allowed,
      retryAfterSeconds: Math.max(1, Math.ceil((result.resetAt.getTime() - now.getTime()) / 1000))
    };
  }

  async loginLockout(ip: string, username: string): Promise<RateLimitResult> {
    const now = this.now();
    const [ipUsernameResult, usernameResult] = await Promise.all([
      this.store.loginLockoutStatus(this.loginKey(ip, username), now),
      this.store.loginLockoutStatus(this.usernameLoginKey(username), now)
    ]);
    const lockedUntil = [ipUsernameResult.lockedUntil, usernameResult.lockedUntil]
      .filter((value): value is Date => value != null)
      .sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
    return {
      allowed: !lockedUntil,
      retryAfterSeconds: lockedUntil
        ? Math.max(1, Math.ceil((lockedUntil.getTime() - now.getTime()) / 1000))
        : 0
    };
  }

  async recordLoginFailure(ip: string, username: string) {
    const now = this.now();
    await Promise.all([
      this.store.recordLoginFailure(this.loginKey(ip, username), LOGIN_FAILURE_LOCKOUT, now),
      this.store.recordLoginFailure(this.usernameLoginKey(username), LOGIN_FAILURE_LOCKOUT, now)
    ]);
  }

  async clearLoginFailures(ip: string, username: string) {
    await Promise.all([
      this.store.clearLoginFailures(this.loginKey(ip, username)),
      this.store.clearLoginFailures(this.usernameLoginKey(username))
    ]);
  }

  private loginKey(ip: string, username: string) {
    return `login-failure:${ip}:${username.trim().toLowerCase()}`;
  }

  private usernameLoginKey(username: string) {
    return `login-failure:username:${username.trim().toLowerCase()}`;
  }
}

const authRateLimits = new AuthRateLimitService(new PostgresAuthRateLimitStore());

export function requestIp(req: express.Request) {
  return req.ip || req.socket.remoteAddress || "unknown";
}

export async function enforceRateLimit(
  req: express.Request,
  res: express.Response,
  key: string,
  options: { limit: number; windowMs: number; message: string }
) {
  const result = await authRateLimits.consume(key, options);
  if (result.allowed) return true;

  res.setHeader("Retry-After", String(result.retryAfterSeconds));
  res.status(429).json({ error: options.message });
  return false;
}

export async function enforceLoginLockout(
  req: express.Request,
  res: express.Response,
  username: string
) {
  const result = await authRateLimits.loginLockout(requestIp(req), username);
  if (result.allowed) return true;

  res.setHeader("Retry-After", String(result.retryAfterSeconds));
  res.status(429).json({ error: "Too many failed login attempts. Try again later." });
  return false;
}

export async function recordLoginFailure(req: express.Request, username: string) {
  await authRateLimits.recordLoginFailure(requestIp(req), username);
}

export async function clearLoginFailures(req: express.Request, username: string) {
  await authRateLimits.clearLoginFailures(requestIp(req), username);
}
