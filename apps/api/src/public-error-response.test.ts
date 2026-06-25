import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { publicErrorResponse } from "./public-error-response";

test("PostgreSQL details and rejected values are never returned", () => {
  const response = publicErrorResponse({
    code: "23505",
    message: 'duplicate key value violates unique constraint "users_email_key"',
    detail: "Key (email)=(private@example.com) already exists.",
    constraint: "users_email_key",
    stack: "private stack trace"
  });

  assert.deepEqual(response, {
    status: 409,
    error: "A record with those details already exists."
  });
  const serialized = JSON.stringify(response);
  assert.doesNotMatch(serialized, /private@example\.com/);
  assert.doesNotMatch(serialized, /users_email_key/);
  assert.doesNotMatch(serialized, /duplicate key/);
  assert.doesNotMatch(serialized, /stack trace/);
});

test("unknown internal errors return only a generic message", () => {
  const response = publicErrorResponse(
    new Error("SELECT * FROM users failed for private@example.com")
  );

  assert.deepEqual(response, {
    status: 500,
    error: "Internal server error"
  });
});

test("validation errors return a safe bad request message", () => {
  let validationError: unknown;
  try {
    z.object({ fieldId: z.number() }).parse({ fieldId: "private" });
  } catch (error) {
    validationError = error;
  }

  const response = publicErrorResponse(validationError);

  assert.deepEqual(response, {
    status: 400,
    error: "One or more fields are invalid."
  });
});

test("request parser failures return safe useful messages", () => {
  assert.deepEqual(
    publicErrorResponse({ type: "entity.parse.failed", body: "private data" }),
    { status: 400, error: "The request contains invalid JSON." }
  );
  assert.deepEqual(
    publicErrorResponse({ type: "entity.too.large", body: "private data" }),
    { status: 413, error: "The request is too large." }
  );
});
