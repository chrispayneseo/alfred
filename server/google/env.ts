import { loadEnv } from "vite";

export interface GoogleEnv {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  redirectUri: string;
}

const REDIRECT_URI = "http://localhost:5173/api/google/oauth/callback";

export function loadGoogleEnv(): GoogleEnv {
  const env = loadEnv("development", process.cwd(), "");
  return {
    clientId: env.GOOGLE_CLIENT_ID ?? "",
    clientSecret: env.GOOGLE_CLIENT_SECRET ?? "",
    refreshToken: env.GOOGLE_REFRESH_TOKEN ?? "",
    redirectUri: REDIRECT_URI,
  };
}
