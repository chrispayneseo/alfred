import { useOnlineStatus } from "../lib/useOnlineStatus";

export function OfflineBanner() {
  const online = useOnlineStatus();

  if (online) return null;

  return (
    <div className="fixed inset-x-0 top-0 z-30 flex items-center justify-center gap-2 bg-accent px-4 py-1.5 text-center text-xs font-medium text-paper dark:bg-accent-dark dark:text-paper-dark">
      <span className="h-1.5 w-1.5 rounded-full bg-current opacity-70" />
      Offline — showing last-known data. Changes will sync later.
    </div>
  );
}
