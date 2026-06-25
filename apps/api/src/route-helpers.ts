import express from "express";
import { AuthenticatedRequest, AuthContext, csrfTokenForRequest } from "./auth";
import { roleMeetsRequirement } from "./permissions";
import { FarmRole } from "./types";

export function asyncHandler(
  handler: (req: express.Request, res: express.Response, next: express.NextFunction) => Promise<void>
) {
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    void handler(req, res, next).catch(next);
  };
}

export function currentAuth(req: express.Request): AuthContext | null {
  return (req as AuthenticatedRequest).auth ?? null;
}

export function requireRole(role: FarmRole = "worker") {
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const auth = currentAuth(req);
    if (!auth) {
      res.status(401).json({ error: "Login required" });
      return;
    }

    if (!roleMeetsRequirement(auth, role)) {
      res.status(403).json({ error: "Planner access required" });
      return;
    }

    next();
  };
}

export function requireAdmin() {
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const auth = currentAuth(req);
    if (!auth) {
      res.status(401).json({ error: "Login required" });
      return;
    }

    if (!auth.isAdmin) {
      res.status(403).json({ error: "Admin access required" });
      return;
    }

    next();
  };
}

export function requireValidCsrfForAuthenticatedWrites(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) {
    next();
    return;
  }

  if (!currentAuth(req)) {
    next();
    return;
  }

  const expectedToken = csrfTokenForRequest(req);
  const providedToken = req.header("x-csrf-token");
  if (!expectedToken || providedToken !== expectedToken) {
    res.status(403).json({ error: "Invalid CSRF token" });
    return;
  }

  next();
}
