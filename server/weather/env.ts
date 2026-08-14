export interface WeatherEnv {
  lat?: number;
  lon?: number;
}

/** Takes a raw env source rather than loading one itself — see
 * google/env.ts for why (dev uses Vite's loadEnv(), prod uses process.env).
 * WEATHER_LOCATION is "lat,lon" (e.g. "50.9891,-1.4999" for Romsey, Hampshire)
 * — resolved once up front rather than geocoding a place name on every
 * request, keeping this a fixed home location with no extra runtime
 * dependency. Leave unset to skip the integration entirely. */
export function loadWeatherEnv(source: Record<string, string | undefined>): WeatherEnv {
  const raw = source.WEATHER_LOCATION ?? "";
  const [latRaw, lonRaw] = raw.split(",").map((s) => s.trim());
  const lat = Number(latRaw);
  const lon = Number(lonRaw);
  if (latRaw && lonRaw && Number.isFinite(lat) && Number.isFinite(lon)) return { lat, lon };
  return {};
}

export function isWeatherConfigured(env: WeatherEnv): boolean {
  return env.lat !== undefined && env.lon !== undefined;
}
