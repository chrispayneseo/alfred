/** No refresh token stored yet — the user has never connected their Google account. */
export class GoogleNotConnectedError extends Error {
  constructor() {
    super("Google account isn't connected yet.");
    this.name = "GoogleNotConnectedError";
  }
}

/** A stored refresh token exists but Google rejected it (revoked, expired, or
 * missing a scope this call needs — e.g. a Calendar-only token used for Gmail). */
export class GoogleReconnectRequiredError extends Error {
  constructor(cause?: unknown) {
    super("Google access needs to be reconnected.");
    this.name = "GoogleReconnectRequiredError";
    this.cause = cause;
  }
}

/** The API itself isn't enabled in the Google Cloud project (distinct from an
 * auth/scope problem — reconnecting OAuth can never fix this; it needs enabling
 * in Cloud Console). Also a 403, so it must be checked before the generic auth check. */
export class GoogleApiDisabledError extends Error {
  constructor(cause?: unknown) {
    super("A required Google API isn't enabled for this project yet.");
    this.name = "GoogleApiDisabledError";
    this.cause = cause;
  }
}

interface GoogleApiErrorShape {
  response?: {
    status?: number;
    data?: {
      error?:
        | string
        | {
            status?: string;
            errors?: Array<{ reason?: string }>;
          };
    };
  };
}

function isServiceDisabledError(error: unknown): boolean {
  const data = (error as GoogleApiErrorShape).response?.data?.error;
  if (!data || typeof data === "string") return false;
  return data.errors?.some((e) => e.reason === "accessNotConfigured") ?? false;
}

/** True for token-invalid (401/invalid_grant) and insufficient-scope (403) responses —
 * both mean "reconnect", just for different reasons (expired vs. granted before a scope existed).
 * Excludes the service-disabled 403 (see GoogleApiDisabledError) — that isn't fixed by reconnecting. */
export function isGoogleAuthError(error: unknown): boolean {
  if (isServiceDisabledError(error)) return false;
  const response = (error as GoogleApiErrorShape).response;
  if (!response) return false;
  const data = response.data?.error;
  if (response.status === 401 || response.status === 403) return true;
  if (response.status === 400 && data === "invalid_grant") return true;
  return false;
}

/** Normalizes a caught error into a stable string the frontend can switch on
 * ("not_connected" / "reconnect_required" / "api_disabled"), falling back to the raw message. */
export function toGoogleErrorCode(error: unknown): string {
  if (error instanceof GoogleNotConnectedError) return "not_connected";
  if (error instanceof GoogleReconnectRequiredError) return "reconnect_required";
  if (error instanceof GoogleApiDisabledError) return "api_disabled";
  if (isServiceDisabledError(error)) return "api_disabled";
  return error instanceof Error ? error.message : "Something went wrong.";
}
