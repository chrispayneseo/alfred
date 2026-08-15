const GEOCODING_BASE_URL = "https://geocoding-api.open-meteo.com/v1/search";

// Cheap pre-filter before spending a network call — a calendar event's
// "location" field is often not a physical place at all. Same philosophy as
// emailScan.ts's looksAutomated: skip the obvious non-cases before asking
// an API to guess. Matched as whole-word-ish substrings, case-insensitive.
const NON_PHYSICAL_LOCATION_TERMS = [
  "zoom",
  "teams",
  "google meet",
  "meet.google",
  "skype",
  "webex",
  "facetime",
  "phone",
  "call",
  "video call",
  "online",
  "virtual",
  "remote",
  "office", // too generic/ambiguous to trust a geocode match against
  "home",
  "tbc",
  "tbd",
  "n/a",
];

export function looksPhysical(location: string): boolean {
  const trimmed = location.trim();
  if (trimmed.length < 3) return false;
  const lower = trimmed.toLowerCase();
  return !NON_PHYSICAL_LOCATION_TERMS.some((term) => lower.includes(term));
}

export interface GeocodedLocation {
  lat: number;
  lon: number;
}

async function searchOnce(name: string): Promise<GeocodedLocation | undefined> {
  const url = new URL(GEOCODING_BASE_URL);
  url.searchParams.set("name", name);
  url.searchParams.set("count", "1");

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Geocoding request failed (${res.status})`);
  const data = (await res.json()) as { results?: { latitude: number; longitude: number }[] };

  const top = data.results?.[0];
  return top ? { lat: top.latitude, lon: top.longitude } : undefined;
}

/** Resolves a free-text location (address, venue, place name) to
 * coordinates via Open-Meteo's free geocoding endpoint. That endpoint is a
 * places/cities gazetteer, not a full address geocoder — it has no idea
 * what "Tower Bridge, London" or "123 High Street, Southampton" is, only
 * "London" and "Southampton" — so a calendar event's often venue-or-address
 * -shaped location is tried as-is first, then (if that comes back empty and
 * the string looks like "<venue/street>, <place>") retried against just the
 * last comma-separated segment, which is usually the town/city. Trusts
 * whichever attempt's top result rather than scoring confidence itself.
 * Never throws: no match either way, an obviously non-physical location, or
 * a failed request all just mean "can't get weather for this event," which
 * callers treat as "omit," never an error. */
export async function geocodeLocation(location: string): Promise<GeocodedLocation | undefined> {
  if (!looksPhysical(location)) return undefined;

  try {
    const direct = await searchOnce(location);
    if (direct) return direct;

    const parts = location.split(",").map((p) => p.trim());
    const lastPart = parts[parts.length - 1];
    if (parts.length > 1 && lastPart && looksPhysical(lastPart)) {
      return await searchOnce(lastPart);
    }
    return undefined;
  } catch (error) {
    console.error(`[weather] failed to geocode "${location}":`, error);
    return undefined;
  }
}
