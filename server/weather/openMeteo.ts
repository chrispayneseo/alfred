import type { WeatherEnv } from "./env.js";

const OPEN_METEO_BASE_URL = "https://api.open-meteo.com/v1/forecast";

// WMO weather codes — the fixed vocabulary Open-Meteo (and most weather
// APIs) use for `weather_code`. https://open-meteo.com/en/docs
const WEATHER_CODE_DESCRIPTIONS: Record<number, string> = {
  0: "clear sky",
  1: "mainly clear",
  2: "partly cloudy",
  3: "overcast",
  45: "foggy",
  48: "foggy",
  51: "light drizzle",
  53: "drizzle",
  55: "heavy drizzle",
  56: "freezing drizzle",
  57: "freezing drizzle",
  61: "light rain",
  63: "rain",
  65: "heavy rain",
  66: "freezing rain",
  67: "freezing rain",
  71: "light snow",
  73: "snow",
  75: "heavy snow",
  77: "snow grains",
  80: "rain showers",
  81: "rain showers",
  82: "heavy rain showers",
  85: "snow showers",
  86: "snow showers",
  95: "thunderstorm",
  96: "thunderstorm with hail",
  99: "thunderstorm with hail",
};

function describeCode(code: number): string {
  return WEATHER_CODE_DESCRIPTIONS[code] ?? "unsettled";
}

const RAIN_CODES = new Set([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82, 95, 96, 99]);
const RAIN_WINDOW_THRESHOLD = 40;

type RainWindow = "morning" | "afternoon" | "evening";

interface OpenMeteoResponse {
  current: { temperature_2m: number; weather_code: number };
  hourly: { time: string[]; precipitation_probability: number[] };
  daily: {
    time: string[];
    weather_code: number[];
    temperature_2m_max: number[];
    temperature_2m_min: number[];
    precipitation_probability_max: number[];
  };
}

export interface WeatherBriefing {
  currentTempC: number;
  currentDescription: string;
  todayHighC: number;
  todayLowC: number;
  todayPrecipProbability: number;
  todayRainWindow?: RainWindow;
  tomorrowDescription: string;
  tomorrowHighC: number;
  tomorrowLowC: number;
  tomorrowPrecipProbability: number;
  /** The short, calm one-liner shown on the Today screen. */
  summaryLine: string;
}

function findRainWindow(hourly: OpenMeteoResponse["hourly"], todayDate: string): RainWindow | undefined {
  const windows: Record<RainWindow, number[]> = { morning: [], afternoon: [], evening: [] };
  hourly.time.forEach((iso, i) => {
    if (!iso.startsWith(todayDate)) return;
    const hour = new Date(iso).getHours();
    const prob = hourly.precipitation_probability[i];
    if (hour >= 6 && hour < 12) windows.morning.push(prob);
    else if (hour >= 12 && hour < 18) windows.afternoon.push(prob);
    else if (hour >= 18 && hour < 24) windows.evening.push(prob);
  });

  let best: RainWindow | undefined;
  let bestProb = RAIN_WINDOW_THRESHOLD;
  for (const window of ["morning", "afternoon", "evening"] as RainWindow[]) {
    const max = Math.max(0, ...windows[window]);
    if (max >= bestProb) {
      best = window;
      bestProb = max;
    }
  }
  return best;
}

function buildSummaryLine(
  current: { tempC: number; description: string },
  today: { rainWindow?: RainWindow; precipProbability: number },
  isRainy: boolean
): string {
  const base = `${capitalize(current.description)}, ${Math.round(current.tempC)}°C`;
  if (today.rainWindow) {
    return `${base}, rain expected this ${today.rainWindow}.`;
  }
  if (isRainy) {
    return `${base}.`;
  }
  if (today.precipProbability >= RAIN_WINDOW_THRESHOLD) {
    return `${base}, chance of rain later today.`;
  }
  return `${base}.`;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Fetches current conditions plus a 2-day outlook from Open-Meteo (free,
 * no API key) for the fixed home location. Never throws — an unconfigured
 * location or a failed request just means no weather data, and callers
 * (Today screen, Chat context) treat `undefined` as "omit/skip", not an
 * error to surface. */
export async function fetchWeatherBriefing(env: WeatherEnv): Promise<WeatherBriefing | undefined> {
  if (env.lat === undefined || env.lon === undefined) return undefined;

  try {
    const url = new URL(OPEN_METEO_BASE_URL);
    url.searchParams.set("latitude", String(env.lat));
    url.searchParams.set("longitude", String(env.lon));
    url.searchParams.set("current", "temperature_2m,weather_code");
    url.searchParams.set("hourly", "precipitation_probability");
    url.searchParams.set("daily", "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max");
    url.searchParams.set("timezone", "auto");
    url.searchParams.set("forecast_days", "2");

    const res = await fetch(url);
    if (!res.ok) throw new Error(`Open-Meteo request failed (${res.status})`);
    const data = (await res.json()) as OpenMeteoResponse;

    const todayDate = data.daily.time[0];
    const currentDescription = describeCode(data.current.weather_code);
    const todayRainWindow = findRainWindow(data.hourly, todayDate);
    const isRainyNow = RAIN_CODES.has(data.current.weather_code);

    return {
      currentTempC: data.current.temperature_2m,
      currentDescription,
      todayHighC: data.daily.temperature_2m_max[0],
      todayLowC: data.daily.temperature_2m_min[0],
      todayPrecipProbability: data.daily.precipitation_probability_max[0],
      todayRainWindow,
      tomorrowDescription: describeCode(data.daily.weather_code[1]),
      tomorrowHighC: data.daily.temperature_2m_max[1],
      tomorrowLowC: data.daily.temperature_2m_min[1],
      tomorrowPrecipProbability: data.daily.precipitation_probability_max[1],
      summaryLine: buildSummaryLine(
        { tempC: data.current.temperature_2m, description: currentDescription },
        { rainWindow: todayRainWindow, precipProbability: data.daily.precipitation_probability_max[0] },
        isRainyNow
      ),
    };
  } catch (error) {
    console.error("[weather] failed to fetch Open-Meteo data:", error);
    return undefined;
  }
}
