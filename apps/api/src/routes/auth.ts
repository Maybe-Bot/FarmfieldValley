import express from "express";
import { PoolClient } from "pg";
import { z } from "zod";
import { normalizeAccountEmail } from "../account-email";
import { accountUniqueViolationMessage } from "../account-unique-errors";
import { accountTokenHash, createAccountToken } from "../account-tokens";
import {
  clearSessionCookie,
  createSessionToken,
  csrfTokenForRequest,
  csrfTokenForSession,
  hashPassword,
  readSessionToken,
  resolveAuthContext,
  setSessionCookie
} from "../auth";
import {
  clearLoginFailures,
  enforceRateLimit,
  enforceLoginLockout,
  LOGIN_ATTEMPT_LIMIT,
  recordLoginFailure,
  REGISTER_ATTEMPT_LIMIT,
  requestIp
} from "../auth-rate-limit";
import { config } from "../config";
import { seedStarterSeedCatalog } from "../default-seed-catalog";
import { pool } from "../db";
import { deliverAccountEmail } from "../email-delivery";
import { assessLoginCredentials } from "../login-security";
import { loginSchema, registerSchema } from "../schemas";
import { asyncHandler } from "../route-helpers";
import { FarmRole } from "../types";

export function createEmailVerificationToken() {
  return createAccountToken();
}

export function emailVerificationTokenHash(token: string) {
  return accountTokenHash(token);
}

export async function sendVerificationEmail(email: string, username: string, token: string) {
  return deliverAccountEmail("verification", { email, username, token });
}

async function seedDefaultBedPresets(client: PoolClient, farmId: number) {
  await client.query(
    `
      insert into bed_presets (farm_id, name, bed_width_m, path_spacing_m, is_road, notes)
      values
        ($1, 'Bare bed 3 ft', 0.9144, 0.6096, false, 'Default bare bed: 3 ft plantable bed with 2 ft path.'),
        ($1, 'Plastic bed 3 ft', 0.9144, 0.9144, false, 'Default plastic bed: 3 ft bed with 3 ft path.'),
        ($1, 'Farm road 12 ft', 3.6576, 0, true, 'Default non-plantable farm road: 12 ft wide.')
      on conflict (farm_id, name) do update
      set bed_width_m = excluded.bed_width_m,
          path_spacing_m = excluded.path_spacing_m,
          is_road = excluded.is_road,
          notes = excluded.notes,
          updated_at = now()
    `,
    [farmId]
  );
}

async function createVerifiedSession(
  client: PoolClient,
  res: express.Response,
  user: { id: number; username: string; display_name: string | null; is_admin: boolean },
  membership: { farm_id: number; farm_name: string; role: FarmRole }
) {
  const token = createSessionToken();
  await client.query(
    `
      insert into user_sessions (user_id, farm_id, session_token, expires_at)
      values ($1, $2, $3, now() + ($4::integer * interval '1 day'))
    `,
    [user.id, membership.farm_id, token, config.sessionMaxAgeDays]
  );
  setSessionCookie(res, token);
  return {
    authenticated: true,
    user: {
      id: user.id,
      username: user.username,
      displayName: user.display_name,
      farmId: membership.farm_id,
      farmName: membership.farm_name,
      role: membership.role,
      isAdmin: user.is_admin
    },
    csrfToken: csrfTokenForSession(token)
  };
}

async function verifyEmailTokenAndCreateSession(token: string, res: express.Response) {
  const tokenHash = emailVerificationTokenHash(token);
  const client = await pool.connect();
  try {
    await client.query("begin");
    const userResult = await client.query<{
      id: number;
      username: string;
      display_name: string | null;
      is_admin: boolean;
    }>(
      `
        update app_users
        set
          email_verified_at = now(),
          email_verification_token_hash = null,
          email_verification_expires_at = null,
          updated_at = now()
        where email_verification_token_hash = $1
          and email_verification_expires_at > now()
          and is_active = true
        returning id, username, display_name, is_admin
      `,
      [tokenHash]
    );
    const user = userResult.rows[0];
    if (!user) {
      await client.query("rollback");
      return null;
    }

    const membershipResult = await client.query<{
      farm_id: number;
      farm_name: string;
      role: FarmRole;
    }>(
      `
        select membership.farm_id, farm.name as farm_name, membership.role
        from farm_memberships membership
        join farms farm on farm.id = membership.farm_id
        where membership.user_id = $1
        order by membership.farm_id
        limit 1
      `,
      [user.id]
    );
    const membership = membershipResult.rows[0];
    if (!membership) {
      await client.query("rollback");
      return null;
    }

    const sessionInfo = await createVerifiedSession(client, res, user, membership);
    await client.query("commit");
    return sessionInfo;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export function registerAuthRoutes(app: express.Express) {
  // Authentication and account setup routes.
  app.get("/api/session", asyncHandler(async (req, res) => {
    const auth = await resolveAuthContext(req);
    if (!auth) {
      res.json({ authenticated: false });
      return;
    }

    res.json({
      authenticated: true,
      user: {
        id: auth.userId,
        username: auth.username,
        displayName: auth.displayName,
        farmId: auth.farmId,
        farmName: auth.farmName,
        role: auth.role,
        isAdmin: auth.isAdmin
      },
      csrfToken: csrfTokenForRequest(req)
    });
  }));

  app.post("/api/auth/login", asyncHandler(async (req, res) => {
    const body = loginSchema.parse(req.body);
    if (!(await enforceRateLimit(req, res, `login:${requestIp(req)}`, LOGIN_ATTEMPT_LIMIT))) {
      return;
    }
    if (!(await enforceLoginLockout(req, res, body.username))) {
      return;
    }
    const client = await pool.connect();
    let transactionOpen = false;
    try {
      await client.query("begin");
      transactionOpen = true;
      const userResult = await client.query<{
        id: number;
        username: string;
        display_name: string | null;
        email: string;
        email_verified_at: string | null;
        password_hash: string;
        is_active: boolean;
        is_admin: boolean;
      }>(
        `
          select id, username, display_name, email, email_verified_at, password_hash, is_active, is_admin
          from app_users
          where lower(username) = lower($1)
          limit 1
        `,
        [body.username]
      );
      const user = userResult.rows[0];
      const loginAssessment = assessLoginCredentials(user, body.password, config.requireEmailVerification);
      if (!loginAssessment.allowed) {
        await client.query("rollback");
        transactionOpen = false;
        await recordLoginFailure(req, body.username);
        res.status(loginAssessment.status).json({ error: loginAssessment.error });
        return;
      }

      const membershipsResult = await client.query<{
        farm_id: number;
        farm_name: string;
        role: FarmRole;
      }>(
        `
          select membership.farm_id, farm.name as farm_name, membership.role
          from farm_memberships membership
          join farms farm on farm.id = membership.farm_id
          left join lateral (
            select max(session.created_at) as last_session_at
            from user_sessions session
            where session.user_id = membership.user_id
              and session.farm_id = membership.farm_id
          ) recent_session on true
          left join lateral (
            select
              (select count(*) from fields field where field.farm_id = membership.farm_id) +
              (select count(*) from plantings planting where planting.farm_id = membership.farm_id) +
              (select count(*) from tasks task where task.farm_id = membership.farm_id) as content_count
          ) farm_content on true
          where membership.user_id = $1
            and ($2::integer is null or membership.farm_id = $2)
          order by
            case when coalesce(farm_content.content_count, 0) > 0 then 0 else 1 end,
            recent_session.last_session_at desc nulls last,
            coalesce(farm_content.content_count, 0) desc,
            membership.farm_id
        `,
        [user.id, body.farmId ?? null]
      );
      const membership = membershipsResult.rows[0];
      if (!membership) {
        await client.query("rollback");
        transactionOpen = false;
        res.status(403).json({ error: "This account does not belong to the requested farm" });
        return;
      }

      const sessionInfo = await createVerifiedSession(client, res, user, membership);
      await client.query("commit");
      transactionOpen = false;
      await clearLoginFailures(req, body.username);
      res.status(201).json(sessionInfo);
    } catch (error) {
      if (transactionOpen) {
        await client.query("rollback");
      }
      throw error;
    } finally {
      client.release();
    }
  }));

  app.post("/api/auth/register", asyncHandler(async (req, res) => {
    const body = registerSchema.parse(req.body);
    const email = normalizeAccountEmail(body.email);
    const verificationRequired = config.requireEmailVerification;
    const verificationToken = verificationRequired ? createEmailVerificationToken() : null;
    if (!(await enforceRateLimit(req, res, `register:${requestIp(req)}`, REGISTER_ATTEMPT_LIMIT))) {
      return;
    }
    const client = await pool.connect();
    try {
      await client.query("begin");
      const farmResult = await client.query<{ id: number; name: string }>(
        `
          insert into farms (name, notes, maps_private)
          values ($1, 'Created from the Loam Ledger landing page', true)
          returning id, name
        `,
        [body.farmName.trim()]
      );
      const farm = farmResult.rows[0];
      await seedStarterSeedCatalog(client, farm.id);
      await seedDefaultBedPresets(client, farm.id);
      const userResult = await client.query<{
        id: number;
        username: string;
        display_name: string | null;
        is_admin: boolean;
      }>(
        `
          insert into app_users (
            email,
            username,
            password_hash,
            display_name,
            email_verified_at,
            email_verification_token_hash,
            email_verification_expires_at
          )
          values ($1, $2, $3, $4, $5, $6, $7)
          returning id, username, display_name, is_admin
        `,
        [
          email,
          body.username.trim(),
          hashPassword(body.password),
          body.displayName?.trim() || null,
          verificationRequired ? null : new Date().toISOString(),
          verificationToken ? emailVerificationTokenHash(verificationToken) : null,
          verificationToken ? new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() : null
        ]
      );
      const user = userResult.rows[0];

      await client.query(
        `
          insert into farm_memberships (farm_id, user_id, role)
          values ($1, $2, 'planner')
        `,
        [farm.id, user.id]
      );

      const delivery = verificationToken
        ? await sendVerificationEmail(email, user.username, verificationToken)
        : { developmentActionUrl: null };
      await client.query("commit");
      if (verificationToken) {
        res.status(201).json({
          authenticated: false,
          verificationRequired: true,
          email,
          ...delivery
        });
        return;
      }

      res.status(201).json(await createVerifiedSession(client, res, user, {
        farm_id: farm.id,
        farm_name: farm.name,
        role: "planner" satisfies FarmRole
      }));
    } catch (error) {
      await client.query("rollback");
      const uniqueMessage = accountUniqueViolationMessage(error);
      if (uniqueMessage) {
        res.status(400).json({ error: uniqueMessage });
        return;
      }
      throw error;
    } finally {
      client.release();
    }
  }));

  const verifyEmailRateLimit = { limit: 20, windowMs: 60 * 60 * 1000, message: "Too many verification attempts. Try again later." };

  app.post("/api/auth/verify-email", asyncHandler(async (req, res) => {
    if (!(await enforceRateLimit(req, res, `verify-email:${requestIp(req)}`, verifyEmailRateLimit))) return;
    const token = z.object({ token: z.string().min(20) }).parse(req.body).token;
    const sessionInfo = await verifyEmailTokenAndCreateSession(token, res);
    if (!sessionInfo) {
      res.status(400).json({ error: "That verification link is invalid or expired." });
      return;
    }
    res.status(201).json(sessionInfo);
  }));

  app.get("/api/auth/verify-email", asyncHandler(async (req, res) => {
    if (!(await enforceRateLimit(req, res, `verify-email:${requestIp(req)}`, verifyEmailRateLimit))) return;
    const token = typeof req.query.token === "string" ? req.query.token : "";
    if (!token) {
      res.redirect(`${config.publicWebUrl}?verified=missing`);
      return;
    }
    const sessionInfo = await verifyEmailTokenAndCreateSession(token, res);
    res.redirect(`${config.publicWebUrl}?verified=${sessionInfo ? "1" : "invalid"}`);
  }));

  app.post("/api/auth/logout", asyncHandler(async (req, res) => {
    const sessionToken = readSessionToken(req);
    if (sessionToken) {
      await pool.query(`delete from user_sessions where session_token = $1`, [sessionToken]);
    }
    clearSessionCookie(res);
    res.json({ ok: true });
  }));
}
