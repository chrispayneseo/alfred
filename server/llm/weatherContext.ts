import type { WeatherEnv } from "../weather/env.js";
import { isWeatherConfigured } from "../weather/env.js";
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

/** Never throws — an unconfigured location or a failed fetch becomes an
 * honest note in the context, same pattern as calendarContext.ts. */
export async function buildWeatherContext(env: WeatherEnv): Promise<string> {
  if (!isWeatherConfigured(env)) {
    return "Weather isn't configured for this Alfred instance — if asked about the weather, say so rather than guessing.";
  }

  const briefing = await fetchWeatherBriefing(env);
  if (!briefing) {
    return "Weather data couldn't be fetched right now due to an error. If asked about the weather, say so rather than guessing.";
  }

  const todayRain = briefing.todayRainWindow
    ? `rain likely this ${briefing.todayRainWindow} (${briefing.todayPrecipProbability}% chance)`
    : `${briefing.todayPrecipProbability}% chance of rain today`;

  return `Here is the real current weather and short forecast for the user's home location — use it to answer precisely, don't guess.

Right now: ${briefing.currentDescription}, ${fmt(briefing.currentTempC)}.
Today: high ${fmt(briefing.todayHighC)}, low ${fmt(briefing.todayLowC)}, ${todayRain}.
Tomorrow: ${briefing.tomorrowDescription}, high ${fmt(briefing.tomorrowHighC)}, low ${fmt(briefing.tomorrowLowC)}, ${briefing.tomorrowPrecipProbability}% chance of rain.`;
}
