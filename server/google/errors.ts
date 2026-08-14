/** No refresh token stored yet — the user has never connected their calendar. */
export class GoogleNotConnectedError extends Error {
  constructor() {
    super("Google Calendar isn't connected yet.");
    this.name = "GoogleNotConnectedError";
  }
}

/** A stored refresh token exists but Google rejected it (revoked, expired, or invalid). */
export class GoogleReconnectRequiredError extends Error {
  constructor(cause?: unknown) {
    super("Google Calendar access needs to be reconnected.");
    this.name = "GoogleReconnectRequiredError";
    this.cause = cause;
  }
}
