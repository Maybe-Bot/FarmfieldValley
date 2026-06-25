import express from "express";
import { AuthContext, createSessionToken, csrfTokenForSession, hashPassword, readSessionToken, setSessionCookie, verifyPassword } from "../auth";
import { enforceRateLimit, requestIp } from "../auth-rate-limit";
import { accountTokenHash, createAccountToken } from "../account-tokens";
import { normalizeAccountEmail } from "../account-email";
import { config } from "../config";
import { pool } from "../db";
import { deliverAccountEmail } from "../email-delivery";
import { asyncHandler, currentAuth, requireRole } from "../route-helpers";
import {
  accountInvitationSchema,
  forgotPasswordSchema,
  invitationAcceptSchema,
  membershipRoleSchema,
  passwordChangeSchema,
  passwordResetSchema
} from "../schemas";
import { FarmRole } from "../types";

const accountEmailRateLimit = {
  limit: 8,
  windowMs: 60 * 60 * 1000,
  message: "Too many account email requests. Try again later."
};

const accountActionRateLimit = {
  limit: 20,
  windowMs: 60 * 60 * 1000,
  message: "Too many account security attempts. Try again later."
};

export function registerAccountManagementRoutes(app: express.Express) {
  app.get("/api/auth/capabilities", (_req, res) => {
    res.json({
      emailVerificationEnabled: config.requireEmailVerification,
      developmentEmailLinks: !config.isProduction && config.emailDeliveryMode === "development"
    });
  });

  app.post("/api/account/password", requireRole("worker"), asyncHandler(async (req, res) => {
    const auth = currentAuth(req) as AuthContext;
    if (!(await enforceRateLimit(req, res, `change-password:user:${auth.userId}`, accountActionRateLimit))) {
      return;
    }
    const body = passwordChangeSchema.parse(req.body);
    const result = await pool.query<{ password_hash: string }>(
      `select password_hash from app_users where id = $1 and is_active = true`,
      [auth.userId]
    );
    if (!result.rows[0] || !verifyPassword(body.currentPassword, result.rows[0].password_hash)) {
      res.status(400).json({ error: "Current password is incorrect." });
      return;
    }

    const sessionToken = readSessionToken(req);
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query(
        `update app_users set password_hash = $2, updated_at = now() where id = $1`,
        [auth.userId, hashPassword(body.newPassword)]
      );
      await client.query(
        `delete from user_sessions where user_id = $1 and ($2::text is null or session_token <> $2)`,
        [auth.userId, sessionToken]
      );
      await client.query("commit");
      res.json({ ok: true });
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }));

  app.post("/api/auth/forgot-password", asyncHandler(async (req, res) => {
    if (!(await enforceRateLimit(req, res, `forgot-password:${requestIp(req)}`, accountEmailRateLimit))) {
      return;
    }
    const body = forgotPasswordSchema.parse(req.body);
    const email = normalizeAccountEmail(body.email);
    const userResult = await pool.query<{ id: number; username: string }>(
      `select id, username from app_users where lower(email) = lower($1) and is_active = true limit 1`,
      [email]
    );
    const user = userResult.rows[0];
    if (!user) {
      res.json({ ok: true });
      return;
    }

    const token = createAccountToken();
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query(
        `update password_reset_tokens set used_at = now() where user_id = $1 and used_at is null`,
        [user.id]
      );
      await client.query(
        `
          insert into password_reset_tokens (user_id, token_hash, expires_at)
          values ($1, $2, now() + interval '1 hour')
        `,
        [user.id, accountTokenHash(token)]
      );
      const delivery = await deliverAccountEmail("password-reset", {
        email,
        username: user.username,
        token
      });
      await client.query("commit");
      res.json({ ok: true, ...delivery });
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }));

  app.post("/api/auth/resend-verification", asyncHandler(async (req, res) => {
    if (!(await enforceRateLimit(req, res, `resend-verification:${requestIp(req)}`, accountEmailRateLimit))) {
      return;
    }
    const body = forgotPasswordSchema.parse(req.body);
    const email = normalizeAccountEmail(body.email);
    const userResult = await pool.query<{ id: number; username: string }>(
      `
        select id, username
        from app_users
        where lower(email) = lower($1)
          and is_active = true
          and email_verified_at is null
        limit 1
      `,
      [email]
    );
    const user = userResult.rows[0];
    if (!user) {
      res.json({ ok: true });
      return;
    }

    const token = createAccountToken();
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query(
        `
          update app_users
          set email_verification_token_hash = $2,
              email_verification_expires_at = now() + interval '24 hours',
              updated_at = now()
          where id = $1
        `,
        [user.id, accountTokenHash(token)]
      );
      const delivery = await deliverAccountEmail("verification", {
        email,
        username: user.username,
        token
      });
      await client.query("commit");
      res.json({ ok: true, ...delivery });
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }));

  app.post("/api/auth/reset-password", asyncHandler(async (req, res) => {
    if (!(await enforceRateLimit(req, res, `reset-password:${requestIp(req)}`, accountActionRateLimit))) {
      return;
    }
    const body = passwordResetSchema.parse(req.body);
    const client = await pool.connect();
    try {
      await client.query("begin");
      const tokenResult = await client.query<{ id: number; user_id: number }>(
        `
          select id, user_id
          from password_reset_tokens
          where token_hash = $1 and used_at is null and expires_at > now()
          for update
        `,
        [accountTokenHash(body.token)]
      );
      const reset = tokenResult.rows[0];
      if (!reset) {
        await client.query("rollback");
        res.status(400).json({ error: "That password reset link is invalid or expired." });
        return;
      }
      await client.query(
        `update app_users set password_hash = $2, updated_at = now() where id = $1 and is_active = true`,
        [reset.user_id, hashPassword(body.newPassword)]
      );
      await client.query(`update password_reset_tokens set used_at = now() where id = $1`, [reset.id]);
      await client.query(`delete from user_sessions where user_id = $1`, [reset.user_id]);
      await client.query("commit");
      res.json({ ok: true });
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }));

  app.get("/api/invitations", requireRole("planner"), asyncHandler(async (req, res) => {
    const auth = currentAuth(req) as AuthContext;
    const result = await pool.query<{
      id: number;
      email: string;
      display_name: string | null;
      role: FarmRole;
      expires_at: string;
      created_at: string;
    }>(
      `
        select id, email, display_name, role, expires_at, created_at
        from farm_invitations
        where farm_id = $1 and accepted_at is null and expires_at > now()
        order by created_at desc
      `,
      [auth.farmId]
    );
    res.json(result.rows.map((row) => ({
      id: row.id,
      email: row.email,
      displayName: row.display_name,
      role: row.role,
      expiresAt: row.expires_at,
      createdAt: row.created_at
    })));
  }));

  app.post("/api/invitations", requireRole("planner"), asyncHandler(async (req, res) => {
    const auth = currentAuth(req) as AuthContext;
    const body = accountInvitationSchema.parse(req.body);
    const email = normalizeAccountEmail(body.email);
    const existingMembership = await pool.query(
      `
        select 1
        from farm_memberships membership
        join app_users app_user on app_user.id = membership.user_id
        where membership.farm_id = $1 and lower(app_user.email) = lower($2)
      `,
      [auth.farmId, email]
    );
    if (existingMembership.rows[0]) {
      res.status(400).json({ error: "That person is already a member of this farm." });
      return;
    }

    const token = createAccountToken();
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query(
        `delete from farm_invitations where farm_id = $1 and lower(email) = lower($2) and accepted_at is null`,
        [auth.farmId, email]
      );
      const invitationResult = await client.query<{ id: number; created_at: string; expires_at: string }>(
        `
          insert into farm_invitations (
            farm_id, email, display_name, role, token_hash, invited_by_user_id, expires_at
          )
          values ($1, $2, $3, $4, $5, $6, now() + interval '7 days')
          returning id, created_at, expires_at
        `,
        [
          auth.farmId,
          email,
          body.displayName?.trim() || null,
          body.role,
          accountTokenHash(token),
          auth.userId
        ]
      );
      const delivery = await deliverAccountEmail("invitation", {
        email,
        token,
        farmName: auth.farmName
      });
      await client.query("commit");
      res.status(201).json({
        id: invitationResult.rows[0].id,
        email,
        displayName: body.displayName?.trim() || null,
        role: body.role,
        createdAt: invitationResult.rows[0].created_at,
        expiresAt: invitationResult.rows[0].expires_at,
        ...delivery
      });
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }));

  app.delete("/api/invitations/:id", requireRole("planner"), asyncHandler(async (req, res) => {
    const auth = currentAuth(req) as AuthContext;
    await pool.query(
      `delete from farm_invitations where id = $1 and farm_id = $2 and accepted_at is null`,
      [Number(req.params.id), auth.farmId]
    );
    res.json({ ok: true });
  }));

  app.get("/api/invitations/inspect", asyncHandler(async (req, res) => {
    const token = typeof req.query.token === "string" ? req.query.token : "";
    const result = await pool.query<{
      email: string;
      display_name: string | null;
      role: FarmRole;
      farm_name: string;
      existing_account: boolean;
    }>(
      `
        select
          invitation.email,
          invitation.display_name,
          invitation.role,
          farm.name as farm_name,
          exists(select 1 from app_users where lower(email) = lower(invitation.email) and is_active = true) as existing_account
        from farm_invitations invitation
        join farms farm on farm.id = invitation.farm_id
        where invitation.token_hash = $1
          and invitation.accepted_at is null
          and invitation.expires_at > now()
        limit 1
      `,
      [accountTokenHash(token)]
    );
    const invitation = result.rows[0];
    if (!invitation) {
      res.status(404).json({ error: "That invitation is invalid or expired." });
      return;
    }
    res.json({
      email: invitation.email,
      displayName: invitation.display_name,
      role: invitation.role,
      farmName: invitation.farm_name,
      existingAccount: invitation.existing_account
    });
  }));

  app.post("/api/invitations/accept", asyncHandler(async (req, res) => {
    if (!(await enforceRateLimit(req, res, `accept-invitation:${requestIp(req)}`, accountActionRateLimit))) {
      return;
    }
    const body = invitationAcceptSchema.parse(req.body);
    const client = await pool.connect();
    try {
      await client.query("begin");
      const invitationResult = await client.query<{
        id: number;
        farm_id: number;
        email: string;
        display_name: string | null;
        role: FarmRole;
        farm_name: string;
      }>(
        `
          select invitation.id, invitation.farm_id, invitation.email, invitation.display_name,
                 invitation.role, farm.name as farm_name
          from farm_invitations invitation
          join farms farm on farm.id = invitation.farm_id
          where invitation.token_hash = $1
            and invitation.accepted_at is null
            and invitation.expires_at > now()
          for update
        `,
        [accountTokenHash(body.token)]
      );
      const invitation = invitationResult.rows[0];
      if (!invitation) {
        await client.query("rollback");
        res.status(400).json({ error: "That invitation is invalid or expired." });
        return;
      }

      const existingResult = await client.query<{
        id: number;
        username: string;
        password_hash: string;
      }>(
        `select id, username, password_hash from app_users where lower(email) = lower($1) and is_active = true limit 1`,
        [invitation.email]
      );

      let userId: number;
      let username: string;
      const existing = existingResult.rows[0];
      if (existing) {
        if (!verifyPassword(body.password, existing.password_hash)) {
          await client.query("rollback");
          res.status(400).json({ error: "The password for that existing account is incorrect." });
          return;
        }
        userId = existing.id;
        username = existing.username;
      } else {
        if (!body.username) {
          await client.query("rollback");
          res.status(400).json({ error: "Choose a username for the new account." });
          return;
        }
        const userResult = await client.query<{ id: number; username: string }>(
          `
            insert into app_users (email, username, password_hash, display_name, email_verified_at)
            values ($1, $2, $3, $4, now())
            returning id, username
          `,
          [
            invitation.email,
            body.username.trim(),
            hashPassword(body.password),
            invitation.display_name
          ]
        );
        userId = userResult.rows[0].id;
        username = userResult.rows[0].username;
      }

      await client.query(
        `
          insert into farm_memberships (farm_id, user_id, role)
          values ($1, $2, $3)
          on conflict (farm_id, user_id) do update set role = excluded.role
        `,
        [invitation.farm_id, userId, invitation.role]
      );
      await client.query(`update farm_invitations set accepted_at = now() where id = $1`, [invitation.id]);

      const sessionToken = createSessionToken();
      await client.query(
        `
          insert into user_sessions (user_id, farm_id, session_token, expires_at)
          values ($1, $2, $3, now() + ($4::integer * interval '1 day'))
        `,
        [userId, invitation.farm_id, sessionToken, config.sessionMaxAgeDays]
      );
      await client.query("commit");
      setSessionCookie(res, sessionToken);
      res.status(201).json({
        authenticated: true,
        user: {
          id: userId,
          username,
          displayName: invitation.display_name,
          farmId: invitation.farm_id,
          farmName: invitation.farm_name,
          role: invitation.role,
          isAdmin: false
        },
        csrfToken: csrfTokenForSession(sessionToken)
      });
    } catch (error) {
      await client.query("rollback");
      const maybeError = error as { code?: string };
      if (maybeError.code === "23505") {
        res.status(400).json({ error: "That username is already taken. Choose another username." });
        return;
      }
      throw error;
    } finally {
      client.release();
    }
  }));

  app.patch("/api/accounts/:id", requireRole("planner"), asyncHandler(async (req, res) => {
    const auth = currentAuth(req) as AuthContext;
    const userId = Number(req.params.id);
    const body = membershipRoleSchema.parse(req.body);
    if (userId === auth.userId) {
      res.status(400).json({ error: "Ask another planner to change your role." });
      return;
    }
    const client = await pool.connect();
    try {
      await client.query("begin");
      const memberships = await client.query<{ user_id: number; role: FarmRole }>(
        `select user_id, role from farm_memberships where farm_id = $1 for update`,
        [auth.farmId]
      );
      const membership = memberships.rows.find((row) => row.user_id === userId);
      if (!membership) {
        await client.query("rollback");
        res.status(404).json({ error: "Farm member not found." });
        return;
      }
      const plannerCount = memberships.rows.filter((row) => row.role === "planner").length;
      if (membership.role === "planner" && body.role !== "planner" && plannerCount <= 1) {
        await client.query("rollback");
        res.status(400).json({ error: "This farm must keep at least one planner." });
        return;
      }
      await client.query(
        `update farm_memberships set role = $3 where farm_id = $1 and user_id = $2`,
        [auth.farmId, userId, body.role]
      );
      await client.query("commit");
      res.json({ ok: true });
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }));

  app.delete("/api/accounts/:id", requireRole("planner"), asyncHandler(async (req, res) => {
    const auth = currentAuth(req) as AuthContext;
    const userId = Number(req.params.id);
    if (userId === auth.userId) {
      res.status(400).json({ error: "You cannot remove your own farm access." });
      return;
    }
    const client = await pool.connect();
    try {
      await client.query("begin");
      const memberships = await client.query<{ user_id: number; role: FarmRole }>(
        `select user_id, role from farm_memberships where farm_id = $1 for update`,
        [auth.farmId]
      );
      const membership = memberships.rows.find((row) => row.user_id === userId);
      if (!membership) {
        await client.query("rollback");
        res.status(404).json({ error: "Farm member not found." });
        return;
      }
      const plannerCount = memberships.rows.filter((row) => row.role === "planner").length;
      if (membership.role === "planner" && plannerCount <= 1) {
        await client.query("rollback");
        res.status(400).json({ error: "This farm must keep at least one planner." });
        return;
      }
      await client.query(`delete from user_sessions where farm_id = $1 and user_id = $2`, [auth.farmId, userId]);
      await client.query(`delete from farm_memberships where farm_id = $1 and user_id = $2`, [auth.farmId, userId]);
      await client.query("commit");
      res.json({ ok: true });
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }));
}
