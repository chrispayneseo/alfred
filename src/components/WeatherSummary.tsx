import { useEffect, useState } from "react";
import { fetchTodayWeather, type WeatherBriefing } from "../integrations/weather/api";
import type { Coords } from "../lib/geolocation";

/** Silent when weather isn't configured or the fetch fails — matches the
 * spec's error handling requirement (omit the section, no error state) and
 * the same fail-quiet pattern used by WeeklyDigestTeaser/Nudges. `coords`
 * (Part 1: live device location) overrides the fixed home location when
 * available; re-fetches whenever it changes (app open/resume). */
export function WeatherSummary({ coords }: { coords?: Coords }) {
  const [weather, setWeather] = useState<WeatherBriefing>();

  useEffect(() => {
    fetchTodayWeather(coords)
      .then(setWeather)
      .catch(() => undefined);
  }, [coords]);

  if (!weather) return null;

  return (
    <p className="mb-6 text-sm text-ink-soft dark:text-ink-soft-dark">{weather.summaryLine}</p>
  );
}
