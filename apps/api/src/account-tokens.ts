import crypto from "node:crypto";

export function createAccountToken() {
  return crypto.randomBytes(32).toString("base64url");
}

export function accountTokenHash(token: string) {
  return crypto.createHash("sha256").update(token).digest("hex");
}
