import type { CalendarEventRecord } from "../google/calendar.js";
import { geocodeLocation } from "./geocode.js";
import { fetchWeatherAt } from "./openMeteo.js";

export interface EventWeather {
  eventId: string;
  description: string;
  tempC: number;
}

function dateTimeParts(event: CalendarEventRecord): { date: string; time?: string } {
  if (event.allDay) return { date: event.start.slice(0, 10) };
  return { date: event.start.slice(0, 10), time: event.start.slice(11, 16) };
}

/** For each event with a geocodable location, fetches the forecast for its
 * own date/time — skipping (not erroring on) events with no location, an
 * obviously non-physical one (see geocode.ts), or a failed lookup. Runs in
 * parallel since each event's lookup is independent. */
export async function fetchEventWeather(events: CalendarEventRecord[]): Promise<EventWeather[]> {
  const withLocation = events.filter((e) => e.location && e.location.trim().length > 0);

  const results = await Promise.all(
    withLocation.map(async (event): Promise<EventWeather | undefined> => {
      const coords = await geocodeLocation(event.location!);
      if (!coords) return undefined;
      const { date, time } = dateTimeParts(event);
      const weather = await fetchWeatherAt(coords.lat, coords.lon, date, time);
      if (!weather) return undefined;
      return { eventId: event.id, description: weather.description, tempC: weather.tempC };
    })
  );

  return results.filter((r): r is EventWeather => r !== undefined);
}
