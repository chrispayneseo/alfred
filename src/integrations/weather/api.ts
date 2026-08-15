export interface WeatherBriefing {
  currentTempC: number;
  currentDescription: string;
  todayHighC: number;
  todayLowC: number;
  todayPrecipProbability: number;
  todayRainWindow?: "morning" | "afternoon" | "evening";
  tomorrowDescription: string;
  tomorrowHighC: number;
  tomorrowLowC: number;
  tomorrowPrecipProbability: number;
  summaryLine: string;
}

/** Returns undefined when weather isn't configured or couldn't be fetched —
 * the Today screen treats that as "omit the section," not an error.
 * `coords` (live device location, Part 1) overrides the fixed home
 * location for this one request when provided. */
export async function fetchTodayWeather(coords?: { lat: number; lon: number }): Promise<WeatherBriefing | undefined> {
  const qs = coords ? `?lat=${coords.lat}&lon=${coords.lon}` : "";
  const res = await fetch(`/api/weather/today${qs}`);
  if (!res.ok) return undefined;
  const data = await res.json();
  return data ?? undefined;
}

export interface EventWeather {
  eventId: string;
  description: string;
  tempC: number;
}

/** Weather at the location of today/tomorrow calendar events that have a
 * physical location (Part 2). Returns [] rather than throwing on any
 * failure — the Today screen just shows events without a weather line. */
export async function fetchEventWeather(): Promise<EventWeather[]> {
  try {
    const res = await fetch("/api/weather/events");
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data.items) ? data.items : [];
  } catch {
    return [];
  }
}
