import { photosLibrary } from './photos-library';
import type { ProvidedFacts } from './source-provider';

/*
 * The time zone of the place a photo was taken, for a capture time that has no offset of its own (API-020): a drone's,
 * read through Lightroom Classic, records the camera's clock and where it was, but no zone. macOS's geocoder answers
 * (in the Photos addon, `zoneAt`), which needs the network but no permission; a place it could not look up now leaves
 * the offset unknown, to be looked up the next time the photo is observed.
 */

export type PlaceZone = (latitude: number, longitude: number) => Promise<string | null | undefined>;

// Zones looked up, by cell of about 10 km: a trip's photos ask a handful of times. Failed lookups are not kept.
const zones = new Map<string, string | null>();
// After a lookup that failed (offline, a captive portal, throttled: each waits up to 15 s in the addon), none is asked
// for this long: a load of many such photos then waits for one failure, not one per photo, and asks again later.
const failurePause = 5 * 60_000;
let failedAt = -Infinity;
const cell = (latitude: number, longitude: number) => (Math.round(latitude * 10) / 10) + ',' + (Math.round(longitude * 10) / 10);

/** The addon's lookup, or undefined where it is not there (another platform, or an addon without it). */
export function addonZone(): PlaceZone | undefined {
  const library = photosLibrary();
  return library && typeof library.zoneAt === 'function' ? (latitude, longitude) => library.zoneAt!(latitude, longitude) : undefined;
}

const twoDigits = (value: number) => String(value).padStart(2, '0');
const formatted = (minutes: number) => (minutes < 0 ? '-' : '+') + twoDigits(Math.floor(Math.abs(minutes) / 60)) + ':' + twoDigits(Math.abs(minutes) % 60);

/** Minutes east of UTC that `zone` was at `instant`; undefined for a zone this runtime does not know. */
function minutesAt(zone: string, instant: number) {
  // The geocoder names a zone at sea by its offset alone ("GMT-0200").
  const fixed = /^GMT([+-])(\d\d)(\d\d)$/.exec(zone);
  if (fixed) return (fixed[1] === '-' ? -1 : 1) * (Number(fixed[2]) * 60 + Number(fixed[3]));
  try {
    const name = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longOffset' }).formatToParts(instant).find(({ type }) => type === 'timeZoneName')?.value;
    const match = name && /^GMT(?:([+-])(\d\d):(\d\d))?$/.exec(name);
    if (!match) return undefined;
    return match[1] ? (match[1] === '-' ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3])) : 0;
  } catch { return undefined; }
}

/**
 * The offset of `zone` at the camera time `dateTime` (wall clock, no offset), as `+06:00`: the offset at the instant the
 * wall clock would show then, so a time just after a change of summer time takes the offset after it.
 */
export function offsetAtWallTime(zone: string, dateTime: string) {
  const wall = Date.parse(dateTime + 'Z');
  if (!Number.isFinite(wall)) return undefined;
  const first = minutesAt(zone, wall);
  if (first === undefined) return undefined;
  const second = minutesAt(zone, wall - first * 60_000);
  return second === undefined ? undefined : formatted(second);
}

/**
 * The zone at a place: from those looked up already, else asked. Undefined where it could not be looked up now, and
 * without asking while lookups pause after a failure.
 */
async function zoneOf(lookup: PlaceZone, latitude: number, longitude: number, now: () => number) {
  const key = cell(latitude, longitude);
  if (zones.has(key)) return zones.get(key);
  if (now() - failedAt < failurePause) return undefined;
  const zone = await lookup(latitude, longitude).catch(() => undefined);
  if (zone !== undefined) zones.set(key, zone);
  else failedAt = now();
  return zone;
}

/**
 * `facts` with the offset of the place it was taken where its capture time has none and it has a location; as it is
 * otherwise, and where the place could not be looked up.
 */
export async function withPlaceOffset(facts: ProvidedFacts, lookup: PlaceZone | undefined = addonZone(),
  { signal, now = Date.now }: { signal?: AbortSignal; now?: () => number } = {}): Promise<ProvidedFacts> {
  const { captured, location } = facts;
  if (!lookup || !captured || captured.offset || !location || signal?.aborted) return facts;
  const zone = await zoneOf(lookup, location.latitude, location.longitude, now);
  const offset = zone ? offsetAtWallTime(zone, captured.dateTime) : undefined;
  return offset ? { ...facts, captured: { ...captured, offset } } : facts;
}

/** Forgets the zones looked up and any failure, for tests. */
export function forgetPlaceZones() { zones.clear(); failedAt = -Infinity; }
