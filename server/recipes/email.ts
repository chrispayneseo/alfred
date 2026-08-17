// Alfred's first outbound-email sender — deliberately separate from Gmail's
// read+draft-only integration (server/google/gmail*.ts), which never sends
// anything. This sends directly via Resend's HTTP API, no SDK dependency
// (a single POST, same minimal style as server/notify/ntfy.ts).
const RESEND_API_URL = "https://api.resend.com/emails";

// Resend's shared onboarding@resend.dev sender works without verifying a
// custom domain, but only for sending TO the email address the Resend
// account itself was signed up with — fine here since the destination is a
// single fixed address anyway (RECIPE_EMAIL_TO).
const FROM_ADDRESS = "Alfred <onboarding@resend.dev>";

export async function sendEmail(apiKey: string, to: string, subject: string, text: string): Promise<void> {
  if (!apiKey) throw new Error("RESEND_API_KEY isn't configured");
  if (!to) throw new Error("RECIPE_EMAIL_TO isn't configured");

  const res = await fetch(RESEND_API_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: FROM_ADDRESS, to: [to], subject, text }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Resend send failed (${res.status}): ${body}`);
  }
}
