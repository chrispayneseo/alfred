import type { Env } from "../db.js";
import type { GoogleAccountEnv } from "../google/accounts.js";
import { getTodayEventsAllAccounts, getTomorrowEventsAllAccounts } from "../google/calendar.js";
import type { WeatherEnv } from "../weather/env.js";
import { isWeatherConfigured } from "../weather/env.js";
import { fetchEventWeather } from "../weather/eventWeather.js";
import { fetchWeatherBriefing } from "../weather/openMeteo.js";

const WEATHER_KEYWORDS = [
  "weather",
  "rain",
  "raining",
  "rainy",
  "forecast",
  "sunny",
  "sunshine",
  "cloudy",
  "overcast",
  "snow",
  "snowing",
  "coat",
  "umbrella",
  "jacket",
  "temperature",
  "degrees",
  "hot",
  "cold",
  "chilly",
  "warm",
  "wind",
  "windy",
  "outside",
];

/** Keyword heuristic — same approach as needsCalendarContext/needsEmailContext. */
export function needsWeatherContext(text: string): boolean {
  const lower = text.toLowerCase();
  return WEATHER_KEYWORDS.some((keyword) => lower.includes(keyword));
}

function fmt(tempC: number): string {
  return `${Math.round(tempC)}°C`;
}

/** Weather at the location of any today/tomorrow calendar event that has a
 * physical location set (Part 2) — independent of whether the home
 * location is configured, since these use each event's own geocoded
 * coordinates. Never throws: a calendar that isn't connected, or nothing
 * geocodable, just means no block to add. */
async function buildEventWeatherBlock(dbEnv: Env, googleAccounts: GoogleAccountEnv[]): Promise<string | undefined> {
  if (googleAccounts.length === 0) return undefined;

  try {
    const [today, tomorrow] = await Promise.all([
      getTodayEventsAllAccounts(dbEnv, googleAccounts),
      getTomorrowEventsAllAccounts(dbEnv, googleAccounts),
    ]);
    const events = [...today.events, ...tomorrow.events];
    const weatherByEventId = new Map(
      (await fetchEventWeather(events)).map((w) => [w.eventId, w] as const)
    );
    if (weatherByEventId.size === 0) return undefined;

    const lines = events
      .filter((e) => weatherByEventId.has(e.id))
      .map((e) => {
        const w = weatherByEventId.get(e.id)!;
        const when = e.allDay
          ? e.start
          : new Date(e.start).toLocaleString(undefined, { weekday: "long", hour: "numeric", minute: "2-digit" });
        return `- "${e.title}" — ${when} at ${e.location}: ${w.description}, ${fmt(w.tempC)}`;
      });

    return `Weather at the location of upcoming calendar events (today/tomorrow) that have a physical location set — use this instead of the home-location weather when the question is about a specific event, not "the weather" generally:\n${lines.join("\n")}`;
  } catch (error) {
    console.error("[weatherContext] failed to build event-weather block:", error);
    return undefined;
  }
}

/** Never throws — an unconfigured location or a failed fetch becomes an
 * honest note in the context, same pattern as calendarContext.ts. */
export async function buildWeatherContext(env: WeatherEnv, dbEnv: Env, googleAccounts: GoogleAccountEnv[]): Promise<string> {
  const parts: string[] = [];

  if (!isWeatherConfigured(env)) {
    parts.push("Weather isn't configured for this Alfred instance — if asked about home/local weather, say so rather than guessing.");
  } else {
    const briefing = await fetchWeatherBriefing(env);
    if (!briefing) {
      parts.push("Weather data couldn't be fetched right now due to an error. If asked about the weather, say so rather than guessing.");
    } else {
      const todayRain = briefing.todayRainWindow
        ? `rain likely this ${briefing.todayRainWindow} (${briefing.todayPrecipProbability}% chance)`
        : `${briefing.todayPrecipProbability}% chance of rain today`;

      parts.push(`Here is the real current weather and short forecast for the user's home location — use it to answer precisely, don't guess.

Right now: ${briefing.currentDescription}, ${fmt(briefing.currentTempC)}.
Today: high ${fmt(briefing.todayHighC)}, low ${fmt(briefing.todayLowC)}, ${todayRain}.
Tomorrow: ${briefing.tomorrowDescription}, high ${fmt(briefing.tomorrowHighC)}, low ${fmt(briefing.tomorrowLowC)}, ${briefing.tomorrowPrecipProbability}% chance of rain.`);
    }
  }

  const eventBlock = await buildEventWeatherBlock(dbEnv, googleAccounts);
  if (eventBlock) parts.push(eventBlock);

  return parts.join("\n\n");
}
