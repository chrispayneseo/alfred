const NTFY_BASE_URL = "https://ntfy.sh";

/** Reusable push sender — a single POST to ntfy.sh/<topic> with the message as
 * the body. Used for nudges now, and meant to be reused as-is for the daily
 * briefing later. Title is kept ASCII-only since ntfy sends it as an HTTP
 * header; put anything else in the body, which is plain UTF-8 text. */
export async function notify(topic: string, message: string, title = "Alfred"): Promise<void> {
  if (!topic) throw new Error("NTFY_TOPIC isn't configured");
  const res = await fetch(`${NTFY_BASE_URL}/${encodeURIComponent(topic)}`, {
    method: "POST",
    body: message,
    headers: { Title: title },
  });
  if (!res.ok) throw new Error(`ntfy push failed (${res.status})`);
}
