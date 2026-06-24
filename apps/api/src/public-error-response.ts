type ErrorLike = {
  code?: unknown;
  status?: unknown;
  statusCode?: unknown;
  type?: unknown;
};

export type PublicErrorResponse = {
  status: number;
  error: string;
};

function isErrorLike(error: unknown): error is ErrorLike {
  return typeof error === "object" && error !== null;
}

/**
 * Convert an unexpected internal error into a safe, useful public response.
 * Never copy unknown messages, PostgreSQL details, constraint names, stack
 * traces, query text, or rejected values into the response.
 */
export function publicErrorResponse(error: unknown): PublicErrorResponse {
  if (!isErrorLike(error)) {
    return { status: 500, error: "Internal server error" };
  }

  const code = typeof error.code === "string" ? error.code : "";

  // PostgreSQL errors are classified only by stable SQLSTATE codes. Their
  // message/detail/constraint fields may contain schema names and user data.
  switch (code) {
    case "23505":
      return {
        status: 409,
        error: "A record with those details already exists."
      };
    case "23503":
      return {
        status: 409,
        error: "This change conflicts with a related record."
      };
    case "23502":
      return { status: 400, error: "A required field is missing." };
    case "23514":
      return {
        status: 400,
        error: "One or more fields contain an unsupported value."
      };
    case "22P02":
      return { status: 400, error: "One or more fields are invalid." };
    case "22007":
    case "22008":
      return { status: 400, error: "One or more dates are invalid." };
    case "22003":
      return {
        status: 400,
        error: "A number is outside the allowed range."
      };
  }

  if (code.startsWith("23")) {
    return {
      status: 409,
      error: "This change conflicts with existing data."
    };
  }
  if (code.startsWith("08")) {
    return {
      status: 503,
      error: "Saved data is temporarily unavailable. Please try again."
    };
  }

  if (error.type === "entity.too.large" || error.status === 413 || error.statusCode === 413) {
    return { status: 413, error: "The request is too large." };
  }
  if (error.type === "entity.parse.failed") {
    return { status: 400, error: "The request contains invalid JSON." };
  }

  return { status: 500, error: "Internal server error" };
}
