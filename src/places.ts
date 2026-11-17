/**
 * Place tracking: turns location fixes into "visits" (stayed 5+ minutes in one spot) and adds up the time
 * per place. Everything is computed and stored on the phone. Nothing is sent anywhere, and no address lookup
 * is used: spots stay "unnamed" until you name them (Home, Office, Gym...).
 */
import { registerPlugin } from '@capacitor/core';
import type { BackgroundGeolocationPlugin } from '@capacitor-community/background-geolocation';

const BG = registerPlugin<BackgroundGeolocationPlugin>('BackgroundGeolocation');

export interface Visit { start: number; end: number; lat: number; lon: number }
export interface Place { id: string; name: string; lat: number; lon: number }
export interface Fix { lat: number; lon: number; accuracy: number; time: number }
interface Cluster { lat: number; lon: number; n: number; start: number; last: number; out: Fix[] }
export interface PlacesState { enabled: boolean; visits: Visit[]; places: Place[]; open: Cluster | null }

const KEY = 'h2ai.places.v1';
/** A stay is every fix within this many metres of where the stay began (its running centre). */
const RADIUS = 80;
/** Ignore fixes that are less precise than this (metres). Indoor/network fixes are often poor. */
const MAX_ACCURACY = 60;
/** Shorter stops (a red light, a pick-up) are not visits. */
const MIN_STAY = 5 * 60_000;
/** This many fixes in a row outside the stay are needed to say you left (one jumpy fix is ignored). */
const LEAVE_FIXES = 2;
/** Visits this close together with a short gap are one visit (GPS flicker splitting a stay). */
const MERGE_GAP = 10 * 60_000;
/** A visit belongs to a named place when it is within this many metres of it. */
export const MATCH = 120;
/** If no fix arrives for this long the app was probably not running, so the old stay is closed at its last fix. */
const STALE = 12 * 3_600_000;
const MAX_VISITS = 3000;

export const state: PlacesState = { enabled: false, visits: [], places: [], open: null };
let persist = true;

export function dist(a: { lat: number; lon: number }, b: { lat: number; lon: number }) {
  const R = 6_371_000;
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) Object.assign(state, JSON.parse(raw));
  } catch { /* start empty */ }
}
export function save() {
  if (!persist) return;
  try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* storage full or blocked */ }
}

// ---------- turning fixes into visits ----------
function closeStay(c: Cluster, end: number) {
  if (end - c.start < MIN_STAY) return;
  const prev = state.visits[state.visits.length - 1];
  if (prev && dist(prev, c) <= RADIUS && c.start - prev.end <= MERGE_GAP) {
    prev.end = end;
    return;
  }
  state.visits.push({ start: c.start, end, lat: c.lat, lon: c.lon });
  if (state.visits.length > MAX_VISITS) state.visits.splice(0, state.visits.length - MAX_VISITS);
}

const fresh = (f: Fix): Cluster => ({ lat: f.lat, lon: f.lon, n: 1, start: f.time, last: f.time, out: [] });

export function ingest(f: Fix) {
  if (f.accuracy > MAX_ACCURACY) return;
  let c = state.open;
  if (c && f.time - c.last > STALE) {
    closeStay(c, c.last);
    c = state.open = null;
  }
  if (!c) {
    state.open = fresh(f);
    return;
  }
  if (dist(c, f) <= RADIUS) {
    c.out = [];
    c.n++;
    c.lat += (f.lat - c.lat) / c.n;
    c.lon += (f.lon - c.lon) / c.n;
    c.last = f.time;
    return;
  }
  c.out.push(f);
  if (c.out.length < LEAVE_FIXES) return;
  // Left. Phones report no fixes while still, so the first fix outside is the best guess for when you set off.
  const [first, ...rest] = c.out;
  closeStay(c, first.time);
  state.open = fresh(first);
  for (const r of rest) ingest(r);
}

// ---------- places and totals ----------
export function placeFor(lat: number, lon: number): Place | null {
  let best: Place | null = null;
  let bestD = MATCH;
  for (const p of state.places) {
    const d = dist(p, { lat, lon });
    if (d <= bestD) { best = p; bestD = d; }
  }
  return best;
}

export interface Row {
  /** group key: place name, or "spot:<n>" for an unnamed spot */
  key: string;
  name: string | null;
  place: Place | null;
  lat: number;
  lon: number;
  ms: number;
  visits: number;
  last: number;
  hint?: string;
}

function visitsWithOpen(now: number): Visit[] {
  const o = state.open;
  const list = [...state.visits];
  if (o && now - o.start >= MIN_STAY) list.push({ start: o.start, end: now, lat: o.lat, lon: o.lon });
  return list;
}

/** Share of a set of visits that falls in the night (22:00-06:00) and in weekday office hours (09:00-18:00). */
function dayParts(vs: Visit[]) {
  let night = 0, work = 0, total = 0;
  for (const v of vs) {
    for (let t = v.start; t < v.end; t += 15 * 60_000) {
      const d = new Date(t);
      const h = d.getHours();
      total++;
      if (h >= 22 || h < 6) night++;
      else if (d.getDay() % 6 !== 0 && h >= 9 && h < 18) work++;
    }
  }
  return total ? { night: night / total, work: work / total } : { night: 0, work: 0 };
}

/** Time per place in [from, to]. Unnamed spots are grouped by proximity and numbered by time spent. */
export function totals(from: number, to: number): Row[] {
  const all = visitsWithOpen(to);
  const spots: { lat: number; lon: number; vs: Visit[] }[] = [];
  const groups = new Map<string, { row: Row; vs: Visit[] }>();

  for (const v of all) {
    const place = placeFor(v.lat, v.lon);
    let key: string;
    if (place) {
      key = place.name.toLowerCase();
    } else {
      let idx = spots.findIndex((s) => dist(s, v) <= MATCH);
      if (idx < 0) { spots.push({ lat: v.lat, lon: v.lon, vs: [] }); idx = spots.length - 1; }
      spots[idx].vs.push(v);
      key = `spot:${idx}`;
    }
    const clipped = Math.min(v.end, to) - Math.max(v.start, from);
    let g = groups.get(key);
    if (!g) {
      g = { row: { key, name: place?.name ?? null, place, lat: place?.lat ?? v.lat, lon: place?.lon ?? v.lon, ms: 0, visits: 0, last: 0 }, vs: [] };
      groups.set(key, g);
    }
    g.vs.push(v);
    if (clipped > 0) {
      g.row.ms += clipped;
      g.row.visits++;
      g.row.last = Math.max(g.row.last, Math.min(v.end, to));
    }
  }

  const rows = [...groups.values()].filter((g) => g.row.ms > 0);
  for (const g of rows) {
    if (g.row.name) continue;
    const { night, work } = dayParts(g.vs);
    if (night >= 0.5) g.row.hint = 'Mostly nights. Home?';
    else if (work >= 0.5) g.row.hint = 'Weekday daytime. Work?';
  }
  return rows.map((g) => g.row).sort((a, b) => b.ms - a.ms);
}

/** Where you are right now, if a stay is in progress. */
export function now(at: number): { row: Row | null; since: number } | null {
  const o = state.open;
  if (!state.enabled || !o) return null;
  const place = placeFor(o.lat, o.lon);
  const dwell = at - o.start;
  if (dwell < MIN_STAY) return null;
  const row = totals(o.start, at).find((r) => (place ? r.name?.toLowerCase() === place.name.toLowerCase() : !r.name && dist(r, o) <= MATCH)) ?? null;
  return { row, since: o.start };
}

export function recentVisits(from: number, to: number, limit = 30) {
  return visitsWithOpen(to)
    .filter((v) => v.end > from)
    .slice(-limit)
    .map((v) => {
      const p = placeFor(v.lat, v.lon);
      return { place: p?.name ?? null, lat: v.lat, lon: v.lon, start: Math.max(v.start, from), end: Math.min(v.end, to) };
    });
}

export function saveName(target: { place?: Place | null; lat: number; lon: number }, name: string) {
  const clean = name.trim().slice(0, 40);
  if (target.place) {
    if (clean) target.place.name = clean;
    else state.places = state.places.filter((p) => p !== target.place);
  } else if (clean) {
    state.places.push({ id: String(Date.now()), name: clean, lat: target.lat, lon: target.lon });
  }
  save();
}

export function clearAll() {
  state.visits = [];
  state.places = [];
  state.open = null;
  save();
}

// ---------- tracking ----------
let watcherId: string | undefined;

export async function startTracking(onChange: () => void, onError: (msg: string) => void) {
  if (watcherId) return;
  watcherId = await BG.addWatcher(
    {
      backgroundTitle: 'Health to AI is tracking places',
      backgroundMessage: 'Time at each place is worked out on this phone only.',
      requestPermissions: true,
      stale: false,
      distanceFilter: 25,
    },
    (loc, err) => {
      if (err) {
        if (err.code === 'NOT_AUTHORIZED') {
          onError('Location is not allowed. Opening settings: choose Location, then Allow.');
          void BG.openSettings();
          void stopTracking();
        } else onError(err.message);
        return;
      }
      if (!loc) return;
      ingest({ lat: loc.latitude, lon: loc.longitude, accuracy: loc.accuracy ?? 30, time: loc.time ?? Date.now() });
      save();
      onChange();
    },
  );
  state.enabled = true;
  save();
}

export async function stopTracking() {
  if (watcherId) {
    try { await BG.removeWatcher({ id: watcherId }); } catch { /* already gone */ }
    watcherId = undefined;
  }
  if (state.open) closeStay(state.open, state.open.last);
  state.open = null;
  state.enabled = false;
  save();
}

// ---------- demo data (computer preview only) ----------
export function seedDemo() {
  persist = false;
  const HOUR = 3_600_000;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const at = (day: number, h: number) => today.getTime() - day * 24 * HOUR + h * HOUR;
  const home = { lat: 51.5, lon: -0.12 };
  const office = { lat: 51.515, lon: -0.09 };
  const gym = { lat: 51.505, lon: -0.11 };
  const cafe = { lat: 51.513, lon: -0.095 };
  const visits: Visit[] = [];
  for (let d = 7; d >= 0; d--) {
    const wd = new Date(at(d, 12)).getDay();
    const work = wd !== 0 && wd !== 6;
    if (work) {
      visits.push({ start: at(d, 0), end: at(d, 8.4), ...home });
      visits.push({ start: at(d, 9.1), end: at(d, 12.6), ...office });
      if (d % 2 === 0) visits.push({ start: at(d, 12.8), end: at(d, 13.4), ...cafe });
      visits.push({ start: at(d, 13.5), end: at(d, 17.7), ...office });
      if (d % 3 === 0) visits.push({ start: at(d, 18.2), end: at(d, 19.1), ...gym });
      visits.push({ start: at(d, 19.6), end: at(d, 24), ...home });
    } else {
      visits.push({ start: at(d, 0), end: at(d, 24), ...home });
    }
  }
  const nowMs = Date.now();
  state.enabled = true;
  state.places = [
    { id: 'h', name: 'Home', ...home },
    { id: 'o', name: 'Office', ...office },
    { id: 'g', name: 'Gym', ...gym },
  ];
  state.visits = visits.filter((v) => v.end < nowMs - 20 * 60_000);
  const last = state.visits[state.visits.length - 1];
  state.open = { lat: office.lat, lon: office.lon, n: 30, start: Math.max(nowMs - 2.5 * HOUR, last?.end ?? 0), last: nowMs, out: [] };
}
