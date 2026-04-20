import { AuthContext } from "./auth";
import { FarmRole } from "./types";

// Central permission rule for farm roles. A planner can do everything a worker
// can do; a worker cannot change planning records.
export function roleMeetsRequirement(auth: Pick<AuthContext, "role"> | null, requiredRole: FarmRole) {
  if (!auth) {
    return false;
  }

  if (requiredRole === "worker") {
    return auth.role === "worker" || auth.role === "planner";
  }

  return auth.role === "planner";
}
