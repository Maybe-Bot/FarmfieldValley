import { config } from "./config";

export type AccountEmailKind = "verification" | "password-reset" | "invitation";

type AccountEmail = {
  to: string;
  subject: string;
  text: string;
  html: string;
};

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function accountActionUrl(path: string, token: string) {
  const url = new URL(path, config.publicWebUrl);
  url.searchParams.set("token", token);
  return url.toString();
}

export function verificationActionUrl(token: string) {
  const url = new URL("/api/auth/verify-email", config.publicApiUrl);
  url.searchParams.set("token", token);
  return url.toString();
}

function messageFor(kind: AccountEmailKind, email: string, username: string | null, actionUrl: string, farmName?: string): AccountEmail {
  const greeting = username ? `Hello ${username},` : "Hello,";
  const safeGreeting = escapeHtml(greeting);
  const safeActionUrl = escapeHtml(actionUrl);
  const safeFarmName = escapeHtml(farmName ?? "a farm");
  if (kind === "password-reset") {
    return {
      to: email,
      subject: "Reset your Loam Ledger password",
      text: `${greeting}\n\nUse this link to reset your Loam Ledger password:\n${actionUrl}\n\nThis link expires in one hour. If you did not request this, you can ignore this email.`,
      html: `<p>${safeGreeting}</p><p>Use this link to reset your Loam Ledger password:</p><p><a href="${safeActionUrl}">Reset password</a></p><p>This link expires in one hour. If you did not request this, you can ignore this email.</p>`
    };
  }
  if (kind === "invitation") {
    return {
      to: email,
      subject: `Join ${farmName ?? "a farm"} on Loam Ledger`,
      text: `${greeting}\n\nYou were invited to join ${farmName ?? "a farm"} on Loam Ledger.\n${actionUrl}\n\nThis link expires in seven days.`,
      html: `<p>${safeGreeting}</p><p>You were invited to join <strong>${safeFarmName}</strong> on Loam Ledger.</p><p><a href="${safeActionUrl}">Accept invitation</a></p><p>This link expires in seven days.</p>`
    };
  }
  return {
    to: email,
    subject: "Verify your Loam Ledger email",
    text: `${greeting}\n\nVerify your email to finish creating your Loam Ledger account:\n${actionUrl}\n\nThis link expires in 24 hours.`,
    html: `<p>${safeGreeting}</p><p>Verify your email to finish creating your Loam Ledger account:</p><p><a href="${safeActionUrl}">Verify email</a></p><p>This link expires in 24 hours.</p>`
  };
}

export async function deliverAccountEmail(
  kind: AccountEmailKind,
  options: { email: string; username?: string | null; token: string; farmName?: string }
) {
  const actionUrl = kind === "verification"
    ? verificationActionUrl(options.token)
    : accountActionUrl(kind === "password-reset" ? "/?reset-password=1" : "/?accept-invite=1", options.token);

  if (config.emailDeliveryMode === "development") {
    return { developmentActionUrl: actionUrl };
  }

  const message = messageFor(kind, options.email, options.username ?? null, actionUrl, options.farmName);
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.resendApiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from: config.emailFrom,
      to: [message.to],
      subject: message.subject,
      text: message.text,
      html: message.html
    })
  });

  if (!response.ok) {
    const detail = await response.text();
    console.error(`[email delivery] Resend rejected ${kind} email with status ${response.status}: ${detail.slice(0, 500)}`);
    throw new Error("Email could not be sent, so the account change was not saved. Try again.");
  }

  return { developmentActionUrl: null };
}
