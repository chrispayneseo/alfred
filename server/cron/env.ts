/** Takes a raw env source rather than loading one itself — see
 * google/env.ts for why (dev uses Vite's loadEnv(), prod uses process.env). */
export function loadGmailCronSecret(source: Record<string, string | undefined>): string {
  return source.GMAIL_CRON_SECRET ?? "";
}
