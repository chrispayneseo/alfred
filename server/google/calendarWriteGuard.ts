// Google doesn't let Alfred request different OAuth scopes for different
// connected accounts — every account that connects or reconnects gets the
// same scope list (oauth.ts's SCOPES), which already includes calendar
// write. That means the only real guarantee that Alfred never writes to the
// work calendar has to live in Alfred's own code, not in what Google
// happens to grant a given account's token. This is that guarantee: every
// calendar-write code path (Chat's event proposals, the calendar-photo
// pipeline) must call assertWritableAccount() before writing anything.
export const WRITABLE_CALENDAR_ACCOUNT = "cpayneer@gmail.com";

export class CalendarAccountNotWritableError extends Error {
  constructor(email: string) {
    super(`Alfred only ever writes calendar events to ${WRITABLE_CALENDAR_ACCOUNT} — refusing to write to ${email}.`);
    this.name = "CalendarAccountNotWritableError";
  }
}

export function assertWritableAccount(email: string): void {
  if (email !== WRITABLE_CALENDAR_ACCOUNT) throw new CalendarAccountNotWritableError(email);
}
