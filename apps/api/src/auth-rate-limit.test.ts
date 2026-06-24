import test from "node:test";
import assert from "node:assert/strict";
import {
  AuthRateLimitService,
  AuthRateLimitStore,
  LOGIN_ATTEMPT_LIMIT,
  LOGIN_FAILURE_LOCKOUT,
  REGISTER_ATTEMPT_LIMIT
} from "./auth-rate-limit";

type WindowBucket = { count: number; resetAt: Date };
type LoginBucket = { failures: number; failureWindowExpiresAt: Date; lockedUntil: Date | null };

class SharedTestStore implements AuthRateLimitStore {
  windows = new Map<string, WindowBucket>();
  logins = new Map<string, LoginBucket>();

  async consumeFixedWindow(key: string, limit: number, windowMs: number, now: Date) {
    const bucket = this.windows.get(key);
    if (!bucket || bucket.resetAt <= now) {
      const resetAt = new Date(now.getTime() + windowMs);
      this.windows.set(key, { count: 1, resetAt });
      return { allowed: true, resetAt };
    }
    bucket.count += 1;
    return { allowed: bucket.count <= limit, resetAt: bucket.resetAt };
  }

  async loginLockoutStatus(key: string, now: Date) {
    const lockedUntil = this.logins.get(key)?.lockedUntil ?? null;
    return { lockedUntil: lockedUntil && lockedUntil > now ? lockedUntil : null };
  }

  async recordLoginFailure(key: string, options: typeof LOGIN_FAILURE_LOCKOUT, now: Date) {
    let bucket = this.logins.get(key);
    if (!bucket || bucket.failureWindowExpiresAt <= now) {
      bucket = {
        failures: 0,
        failureWindowExpiresAt: new Date(now.getTime() + options.failureWindowMs),
        lockedUntil: null
      };
      this.logins.set(key, bucket);
    }
    bucket.failures += 1;
    if (bucket.failures >= options.failureLimit) {
      bucket.lockedUntil = new Date(now.getTime() + options.lockoutMs);
    }
  }

  async clearLoginFailures(key: string) {
    this.logins.delete(key);
  }
}

test("register attempts lock after eight requests and remain locked across instances", async () => {
  const store = new SharedTestStore();
  const firstInstance = new AuthRateLimitService(store, () => new Date("2026-06-22T12:00:00Z"));

  for (let attempt = 1; attempt <= REGISTER_ATTEMPT_LIMIT.limit; attempt += 1) {
    assert.equal(
      (await firstInstance.consume("register:203.0.113.4", REGISTER_ATTEMPT_LIMIT)).allowed,
      true
    );
  }

  const restartedInstance = new AuthRateLimitService(store, () => new Date("2026-06-22T12:05:00Z"));
  const blocked = await restartedInstance.consume("register:203.0.113.4", REGISTER_ATTEMPT_LIMIT);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.retryAfterSeconds, 55 * 60);
});

test("login request rate limit is shared across API instances", async () => {
  const store = new SharedTestStore();
  const firstInstance = new AuthRateLimitService(store, () => new Date("2026-06-22T12:00:00Z"));
  const secondInstance = new AuthRateLimitService(store, () => new Date("2026-06-22T12:00:00Z"));

  for (let attempt = 1; attempt <= LOGIN_ATTEMPT_LIMIT.limit; attempt += 1) {
    const instance = attempt % 2 === 0 ? firstInstance : secondInstance;
    assert.equal((await instance.consume("login:198.51.100.8", LOGIN_ATTEMPT_LIMIT)).allowed, true);
  }

  assert.equal(
    (await secondInstance.consume("login:198.51.100.8", LOGIN_ATTEMPT_LIMIT)).allowed,
    false
  );
});

test("repeated login attempts from one IP lock that IP and username", async () => {
  const store = new SharedTestStore();
  let now = new Date("2026-06-22T12:00:00Z");
  const limiter = new AuthRateLimitService(store, () => now);

  for (let failure = 1; failure <= LOGIN_FAILURE_LOCKOUT.failureLimit; failure += 1) {
    assert.equal((await limiter.loginLockout("192.0.2.10", " Farmer ")).allowed, true);
    await limiter.recordLoginFailure("192.0.2.10", " Farmer ");
  }

  const blocked = await limiter.loginLockout("192.0.2.10", "farmer");
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.retryAfterSeconds, 30 * 60);

  now = new Date(now.getTime() + LOGIN_FAILURE_LOCKOUT.lockoutMs + 1);
  assert.equal((await limiter.loginLockout("192.0.2.10", "farmer")).allowed, true);
});

test("repeated login attempts from multiple IPs lock the username", async () => {
  const store = new SharedTestStore();
  const limiter = new AuthRateLimitService(store, () => new Date("2026-06-22T12:00:00Z"));

  for (let failure = 1; failure <= LOGIN_FAILURE_LOCKOUT.failureLimit; failure += 1) {
    const ip = `192.0.2.${failure}`;
    assert.equal((await limiter.loginLockout(ip, "farmer")).allowed, true);
    await limiter.recordLoginFailure(ip, "farmer");
  }

  const blocked = await limiter.loginLockout("192.0.2.99", " Farmer ");
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.retryAfterSeconds, 30 * 60);
});

test("a successful login clears prior failures", async () => {
  const store = new SharedTestStore();
  const limiter = new AuthRateLimitService(store, () => new Date("2026-06-22T12:00:00Z"));

  for (let failure = 1; failure < LOGIN_FAILURE_LOCKOUT.failureLimit; failure += 1) {
    await limiter.recordLoginFailure("192.0.2.20", "farmer");
  }
  await limiter.clearLoginFailures("192.0.2.20", "farmer");

  for (let failure = 1; failure < LOGIN_FAILURE_LOCKOUT.failureLimit; failure += 1) {
    await limiter.recordLoginFailure("192.0.2.20", "farmer");
  }
  assert.equal((await limiter.loginLockout("192.0.2.20", "farmer")).allowed, true);
});
