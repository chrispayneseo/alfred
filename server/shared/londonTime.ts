/** Resolves a "YYYY-MM-DD" + "HH:MM" pair, understood as Europe/London wall-clock
 * time, to the correct UTC instant — tries both the BST (+1) and GMT (+0)
 * offsets and keeps whichever one round-trips back to the requested local
 * time. Avoids needing a DST calendar or a new dependency. */
export function londonTimeToUtc(dateStr: string, timeStr: string): Date {
  for (const offsetHours of [1, 0]) {
    const guess = new Date(`${dateStr}T${timeStr}:00.000Z`);
    guess.setUTCHours(guess.getUTCHours() - offsetHours);
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat("en-GB", {
        timeZone: "Europe/London",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).formatToParts(guess).map((p) => [p.type, p.value])
    );
    const rendered = `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
    if (rendered === `${dateStr} ${timeStr}`) return guess;
  }
  return new Date(`${dateStr}T${timeStr}:00.000Z`);
}
