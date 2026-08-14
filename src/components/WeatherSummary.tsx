import { useEffect, useState } from "react";
import { fetchTodayWeather, type WeatherBriefing } from "../integrations/weather/api";

/** Silent when weather isn't configured or the fetch fails — matches the
 * spec's error handling requirement (omit the section, no error state) and
 * the same fail-quiet pattern used by WeeklyDigestTeaser/Nudges. */
export function WeatherSummary() {
  const [weather, setWeather] = useState<WeatherBriefing>();

  useEffect(() => {
    fetchTodayWeather()
      .then(setWeather)
      .catch(() => undefined);
  }, []);

  if (!weather) return null;

  return (
    <p className="mb-6 text-sm text-ink-soft dark:text-ink-soft-dark">{weather.summaryLine}</p>
  );
}
