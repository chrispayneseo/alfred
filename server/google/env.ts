export interface GoogleEnv {
  clientId: string;
  clientSecret: string;
  /** Legacy pre-Step-8 single-account field — unused now that accounts live
   * in Postgres (server/google/accounts.ts), kept only so GoogleEnv can still
   * structurally satisfy GoogleAccountEnv's base shape. */
  refreshToken: string;
  redirectUri: string;
}

const DEV_REDIRECT_URI = "http://localhost:5173/api/google/oauth/callback";

/** Takes a raw env source rather than loading one itself, so the same
 * function works from Vite's loadEnv() (local dev, via server/apiPlugin.ts)
 * and from process.env (Vercel, via api/[...path].ts) without importing
 * `vite` — a dev-only dependency that isn't available in production. */
export function loadGoogleEnv(source: Record<string, string | undefined>): GoogleEnv {
  return {
    clientId: source.GOOGLE_CLIENT_ID ?? "",
    clientSecret: source.GOOGLE_CLIENT_SECRET ?? "",
    refreshToken: "",
    // Explicit in production (Vercel dashboard, Production env only — preview
    // deployments get per-deploy URLs that can't be pre-registered with
    // Google, so OAuth simply won't work from previews). Defaults to
    // localhost for local dev when unset.
    redirectUri: source.GOOGLE_REDIRECT_URI || DEV_REDIRECT_URI,
  };
}
