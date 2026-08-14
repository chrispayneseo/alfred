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
 * the Today screen treats that as "omit the section," not an error. */
export async function fetchTodayWeather(): Promise<WeatherBriefing | undefined> {
  const res = await fetch("/api/weather/today");
  if (!res.ok) return undefined;
  const data = await res.json();
  return data ?? undefined;
}
