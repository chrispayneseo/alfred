// Assigns each connected account a stable color by its position in the
// canonical, connection-ordered account list (server/google/accounts.ts
// preserves this order across reconnects) — not a hash of the email, so it
// stays predictable and simple for the two accounts this step is scoped to.
export type AccountColor = "a" | "b";

const PALETTE: AccountColor[] = ["a", "b"];

export function buildAccountColorMap(accounts: { email: string }[]): Map<string, AccountColor> {
  const map = new Map<string, AccountColor>();
  accounts.forEach((account, index) => map.set(account.email, PALETTE[index % PALETTE.length]));
  return map;
}
