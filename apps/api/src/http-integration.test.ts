import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { AuthContext, AuthenticatedRequest, csrfTokenForSession } from "./auth";
import { config } from "./config";
import { requireRole, requireValidCsrfForAuthenticatedWrites } from "./route-helpers";

const sessionToken = "integration-session";
const plannerAuth: AuthContext = {
  userId: 1,
  username: "planner",
  displayName: "Planner",
  farmId: 7,
  farmName: "Integration Farm",
  role: "planner",
  isAdmin: false
};

type TestResponse = {
  statusCode: number;
  body: unknown;
  status: (code: number) => TestResponse;
  json: (body: unknown) => TestResponse;
};

function testResponse(): TestResponse {
  return {
    statusCode: 200,
    body: null,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    }
  };
}

async function dispatchMutation(options: {
  authenticated?: boolean;
  csrf?: boolean;
  route: string;
}) {
  const headers = new Map<string, string>();
  if (options.authenticated) {
    headers.set("cookie", `${config.sessionCookieName}=${sessionToken}`);
  }
  if (options.csrf) {
    headers.set("x-csrf-token", csrfTokenForSession(sessionToken));
  }

  const req = {
    method: "POST",
    path: options.route.replace(/^\/api/, ""),
    headers: Object.fromEntries(headers),
    header(name: string) {
      return headers.get(name.toLowerCase());
    }
  } as unknown as express.Request;
  if (options.authenticated) {
    (req as AuthenticatedRequest).auth = plannerAuth;
  }
  const res = testResponse();
  let csrfPassed = false;
  requireValidCsrfForAuthenticatedWrites(req, res as unknown as express.Response, () => {
    csrfPassed = true;
  });
  if (!csrfPassed) {
    return res;
  }

  let rolePassed = false;
  requireRole("planner")(req, res as unknown as express.Response, () => {
    rolePassed = true;
  });
  if (!rolePassed) {
    return res;
  }

  res.status(201).json({ ok: true });

  return res;
}

test("unauthenticated mutation requests return 401", async () => {
  const response = await dispatchMutation({ route: "/api/plantings" });
  assert.equal(response.statusCode, 401);
});

test("valid session without CSRF returns 403", async () => {
  const response = await dispatchMutation({ route: "/api/plantings", authenticated: true });
  assert.equal(response.statusCode, 403);
});

test("valid session with CSRF succeeds for representative mutation route groups", async () => {
  const routes = [
    "/api/fields",
    "/api/plantings",
    "/api/tasks/1/record",
    "/api/task-flows",
    "/api/import/spreadsheet",
    "/api/seed-items",
    "/api/farm/settings"
  ];

  for (const route of routes) {
    const response = await dispatchMutation({ route, authenticated: true, csrf: true });
    assert.equal(response.statusCode, 201, route);
  }
});
