const LAST_OPEN_KEY = "alfred:lastOpenDate";

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Today is the default screen the first time the app is opened on a given
 * calendar day; Chat is the default for every subsequent open that day.
 * Computed once at module load (not inside a component render, which React
 * StrictMode double-invokes and would otherwise register two "opens").
 */
const today = todayKey();
const lastOpen = localStorage.getItem(LAST_OPEN_KEY);
localStorage.setItem(LAST_OPEN_KEY, today);
const dailyLandingRoute: "/today" | "/chat" = lastOpen === today ? "/chat" : "/today";

export function getDailyLandingRoute(): "/today" | "/chat" {
  return dailyLandingRoute;
}
