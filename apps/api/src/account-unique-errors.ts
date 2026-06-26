type PostgresErrorLike = {
  code?: string;
  constraint?: string;
};

export function accountUniqueViolationMessage(error: unknown) {
  const maybeError = error as PostgresErrorLike;
  if (maybeError.code !== "23505") {
    return null;
  }

  const constraint = maybeError.constraint ?? "";
  if (constraint.includes("email")) {
    return "That email is already used by an active account. Delete that active account first, or use a different email.";
  }
  if (constraint.includes("username")) {
    return "That username is already taken. Choose a new username.";
  }
  return "That username or email is already used by an active account.";
}
