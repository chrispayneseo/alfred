import type { AccountColor } from "../lib/accountColor";

const colorClass: Record<AccountColor, string> = {
  a: "text-account-a",
  b: "text-account-b",
};

/** Small colored dot + short label identifying which connected Google
 * account something came from — mirrors ModelTag's styling. Only worth
 * rendering once more than one account is connected; the caller decides that. */
export function AccountTag({ email, color }: { email: string; color: AccountColor }) {
  const shortLabel = email.split("@")[0];
  return (
    <span
      className={`inline-flex items-center gap-1 text-[10px] font-medium tracking-wide ${colorClass[color]}`}
      title={email}
    >
      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-current opacity-60" />
      {shortLabel}
    </span>
  );
}
