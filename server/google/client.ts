import { OAuth2Client } from "google-auth-library";
import type { GoogleEnv } from "./env";

/** Bare OAuth2 client for the auth flow itself (no refresh token yet). */
export function createOAuth2Client(env: GoogleEnv): OAuth2Client {
  return new OAuth2Client({
    clientId: env.clientId,
    clientSecret: env.clientSecret,
    redirectUri: env.redirectUri,
  });
}

/** OAuth2 client pre-loaded with the stored refresh token, for making API calls. */
export function createAuthenticatedClient(env: GoogleEnv): OAuth2Client {
  const client = createOAuth2Client(env);
  client.setCredentials({ refresh_token: env.refreshToken });
  return client;
}
