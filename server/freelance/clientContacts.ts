import { FREELANCE_CLIENTS, type FreelanceClient } from "../notion/schema.js";

// Known contact domains/keywords per client, used to filter the synced
// Gmail cache down to relevant email — not exhaustive, just enough to
// surface the obvious matches. Add a domain here as it becomes known.
const CLIENT_EMAIL_HINTS: Record<FreelanceClient, string[]> = {
  "Active Health Hub": ["activehealthhub.co.uk", "active health hub"],
  "Rafique Aesthetics": ["rafique"],
  "Steadfast Collective": ["steadfast"],
};

export function emailSearchTermsFor(client: string): string[] {
  return CLIENT_EMAIL_HINTS[client as FreelanceClient] ?? [client];
}

export function isFreelanceClient(value: string): value is FreelanceClient {
  return (FREELANCE_CLIENTS as readonly string[]).includes(value);
}
