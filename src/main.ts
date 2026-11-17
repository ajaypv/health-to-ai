import { Clipboard } from '@capacitor/clipboard';
import { Capacitor } from '@capacitor/core';
import { Share } from '@capacitor/share';
import { Health as NativeHealth } from '@capgo/capacitor-health';
import type { HealthDataType, HealthSample, SleepStage, Workout } from '@capgo/capacitor-health';
import { demoHealth } from './demo';
import { approxTokens, buildExport } from './export';
import type { ExportFormat } from './export';
import { GROUPS, METRICS, fmtDistance, fmtMinutes } from './metrics';
import type { Metric } from './metrics';
import * as Places from './places';
import type { ExportData, MetricResult, PlacesExport, SleepSession } from './types';

/** `?demo` in a desktop browser swaps in fake data so the screen can be previewed. Never used on Android. */
const DEMO = !Capacitor.isNativePlatform() && new URLSearchParams(location.search).has('demo');
const Health = (DEMO ? demoHealth : NativeHealth) as typeof NativeHealth;

// ---------- small helpers ----------
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const contentEl = $('content');
const show = (e: HTMLElement, on: boolean) => { e.hidden = !on; };
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

type State = 'busy' | 'ok' | 'err' | 'idle';
function setStatus(msg: string, state: State = 'idle') {
  const s = $('status');
  s.dataset.state = state;
  s.querySelector('span')!.textContent = msg;
  $('refresh').classList.toggle('spin', state === 'busy');
}

let toastTimer = 0;
function toast(msg: string) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => t.classList.remove('on'), 2200);
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string, ...kids: Node[]) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  node.append(...kids);
  return node;
}

const DAY = 86_400_000;
const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const dayKey = (d: Date | string) => {
  const x = typeof d === 'string' ? new Date(d) : d;
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
};
const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const dateTime = (iso: string) =>
  new Date(iso).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function ago(iso: string) {
  const min = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  if (min < 2) return 'just now';
  if (min < 60) return `${min} min ago`;
  if (min < 48 * 60) return `${Math.round(min / 60)} h ago`;
  return `${Math.round(min / 1440)} days ago`;
}

/** Run async jobs a few at a time: Health Connect rate-limits apps that fire too many reads at once. */
async function pool<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
  return out;
}

// ---------- reading data ----------
const iso = (d: Date) => d.toISOString();

async function aggDaily(id: HealthDataType, from: Date, to: Date) {
  const res = await Health.queryAggregated({ dataType: id, startDate: iso(from), endDate: iso(to), bucket: 'day', aggregation: 'sum' });
  return res.samples.filter((s) => num(s.value)).map((s) => ({ date: dayKey(s.startDate), value: s.value }));
}

async function samplesDaily(id: HealthDataType, from: Date, to: Date) {
  const { samples } = await Health.readSamples({ dataType: id, startDate: iso(from), endDate: iso(to), limit: 5000 });
  const byDay = new Map<string, number>();
  for (const s of samples) byDay.set(dayKey(s.startDate), (byDay.get(dayKey(s.startDate)) ?? 0) + s.value);
  return [...byDay].map(([date, value]) => ({ date, value }));
}

const newest = (a: HealthSample, b: HealthSample) => new Date(b.endDate).getTime() - new Date(a.endDate).getTime();

async function readMetric(m: Metric, from: Date, to: Date): Promise<MetricResult> {
  const r: MetricResult = { id: m.id, label: m.label, group: m.group, kind: m.kind, count: 0 };

  if (m.kind === 'sum') {
    const daily = m.aggregated ? await aggDaily(m.id, from, to) : await samplesDaily(m.id, from, to);
    r.daily = daily;
    r.count = daily.length;
    r.today = daily.find((d) => d.date === dayKey(to))?.value ?? 0;
    return r;
  }

  // 'latest' metrics are rare, so always look back 30 days (Health Connect's default access window).
  const windowFrom = m.kind === 'latest' ? new Date(to.getTime() - 30 * DAY) : from;
  const { samples } = await Health.readSamples({
    dataType: m.id,
    startDate: iso(windowFrom),
    endDate: iso(to),
    limit: m.kind === 'stat' ? 1000 : 50,
    ascending: false,
  });
  const sorted = [...samples].sort(newest);
  r.count = sorted.length;
  const last = sorted[0];
  if (last) {
    const text = m.id === 'bloodPressure' && num(last.systolic) && num(last.diastolic) ? `${Math.round(last.systolic)}/${Math.round(last.diastolic)} mmHg` : undefined;
    r.latest = { value: last.value, text, at: last.endDate, source: last.sourceName };
  }

  if (m.kind === 'stat') {
    if (m.aggregated) {
      // Exact avg/min/max from Health Connect, one bucket per day.
      const res = await Health.queryAggregated({ dataType: m.id, startDate: iso(from), endDate: iso(to), bucket: 'day', aggregation: ['average', 'min', 'max'] });
      const avgs = res.samples.map((s) => s.values.average).filter(num);
      const mins = res.samples.map((s) => s.values.min).filter(num);
      const maxs = res.samples.map((s) => s.values.max).filter(num);
      if (avgs.length) r.avg = avgs.reduce((a, b) => a + b, 0) / avgs.length;
      if (mins.length) r.min = Math.min(...mins);
      if (maxs.length) r.max = Math.max(...maxs);
    } else if (sorted.length) {
      const vals = sorted.map((s) => s.value);
      r.avg = vals.reduce((a, b) => a + b, 0) / vals.length;
      r.min = Math.min(...vals);
      r.max = Math.max(...vals);
    }
    if (m.id === 'heartRate') {
      const res = await Health.queryAggregated({ dataType: 'heartRate', startDate: iso(startOfDay(to)), endDate: iso(to), bucket: 'hour', aggregation: 'average' });
      const hourly: (number | null)[] = Array.from({ length: 24 }, () => null);
      for (const s of res.samples) if (num(s.value)) hourly[new Date(s.startDate).getHours()] = s.value;
      if (hourly.some((v) => v !== null)) r.hourly = hourly;
    }
  }
  return r;
}

async function readSleep(from: Date, to: Date): Promise<SleepSession[]> {
  const { samples } = await Health.readSamples({ dataType: 'sleep', startDate: iso(from), endDate: iso(to), limit: 100, ascending: false });
  return [...samples].sort(newest).map((s) => {
    const stages: Record<string, number> = {};
    for (const st of (s.stages ?? []) as SleepStage[]) stages[st.stage] = (stages[st.stage] ?? 0) + st.durationMinutes;
    const asleep = s.hasStageData
      ? Object.entries(stages).filter(([k]) => k !== 'awake' && k !== 'inBed').reduce((a, [, v]) => a + v, 0)
      : s.value;
    return { start: s.startDate, end: s.endDate, totalMinutes: s.value, asleepMinutes: asleep, stages, source: s.sourceName };
  });
}

async function readWorkouts(from: Date, to: Date): Promise<Workout[]> {
  const res = await Health.queryWorkouts({ startDate: iso(from), endDate: iso(to), limit: 100, ascending: false });
  return res.workouts;
}

// ---------- rendering ----------
const ICONS: Partial<Record<HealthDataType, string>> = {
  steps: '👣', distance: '🚶', distanceCycling: '🚴', flightsClimbed: '🪜', calories: '🔥', totalCalories: '⚡', mindfulness: '🧘',
  heartRate: '❤️', restingHeartRate: '💗', heartRateVariability: '📈', oxygenSaturation: '🫁', respiratoryRate: '🌬️', vo2Max: '🏃', bloodPressure: '🩸',
  weight: '⚖️', height: '📏', bodyFat: '📊', bodyTemperature: '🌡️', basalBodyTemperature: '🌡️', basalCalories: '🔋', bloodGlucose: '🍬',
  dietaryEnergyConsumed: '🍽️', dietaryProtein: '🥩', dietaryWater: '💧',
};

const WORKOUT_ICONS: Record<string, string> = {
  running: '🏃', runningTreadmill: '🏃', walking: '🚶', hiking: '🥾', cycling: '🚴', bikingStationary: '🚴', swimming: '🏊', swimmingPool: '🏊',
  yoga: '🧘', strengthTraining: '🏋️', traditionalStrengthTraining: '🏋️', weightlifting: '🏋️', rowing: '🚣', tennis: '🎾', soccer: '⚽', basketball: '🏀',
  dance: '💃', boxing: '🥊', elliptical: '🏃', stairClimbing: '🪜',
};
const prettify = (s: string) => {
  const t = s.replace(/([A-Z])/g, ' $1').toLowerCase();
  return t.charAt(0).toUpperCase() + t.slice(1);
};

const GOAL_STEPS = 10_000;
const GROUP_SLUG: Record<Metric['group'], string> = { Activity: 'activity', 'Heart & stress': 'heart', Body: 'body', Nutrition: 'nutrition' };

function icon(emoji: string, cls = 'ic') {
  const e = el('span', cls, emoji);
  e.setAttribute('aria-hidden', 'true');
  return e;
}

/** Bars for the last `days` days, today highlighted. */
function bars(values: number[]) {
  const max = Math.max(...values, 1);
  const wrap = el('div', 'bars');
  values.forEach((v, i) => {
    const bar = el('i', i === values.length - 1 ? 'last' : v === 0 ? 'empty' : '');
    bar.style.height = `${Math.max(6, (v / max) * 100)}%`;
    wrap.append(bar);
  });
  return wrap;
}

function series(r: MetricResult, days: number, to: Date): number[] {
  const map = new Map((r.daily ?? []).map((d) => [d.date, d.value]));
  return Array.from({ length: days }, (_, i) => map.get(dayKey(new Date(to.getTime() - (days - 1 - i) * DAY))) ?? 0);
}

/** "42.9 ml/kg/min" -> big number, small unit. Text like "6h 44m" is left whole. */
function splitUnit(text: string): [string, string] {
  const hit = /^(-?[\d.,/]+)\s+(\S.*)$/.exec(text);
  return hit ? [hit[1], hit[2]] : [text, ''];
}
function valueEl(text: string) {
  const [n, u] = splitUnit(text);
  return el('span', 'value', n, ...(u ? [el('small', undefined, u)] : []));
}

function metricCard(r: MetricResult, m: Metric, days: number, to: Date): HTMLElement {
  const card = el('div', 'card');
  card.append(el('div', 'card-head', undefined, icon(ICONS[m.id] ?? '•'), el('span', 'label', r.label)));

  if (m.kind === 'sum') {
    card.append(valueEl(m.format(r.today ?? 0)));
    const total = (r.daily ?? []).reduce((a, d) => a + d.value, 0);
    card.append(el('span', 'sub', days === 1 ? 'today' : `today · avg ${m.format(total / days)} a day`));
    if (days > 1) card.append(bars(series(r, days, to)));
    return card;
  }

  const l = r.latest;
  card.append(l ? valueEl(l.text ?? m.format(l.value)) : el('span', 'value', '–'));
  if (l) card.append(el('span', 'sub', ago(l.at)));
  if (r.kind === 'stat' && num(r.avg) && num(r.min) && num(r.max)) {
    const [avg, unit] = splitUnit(m.format(r.avg));
    const range = `${splitUnit(m.format(r.min))[0]}–${splitUnit(m.format(r.max))[0]}`;
    card.append(el('span', 'sub', `avg ${avg} · range ${range} ${unit}`.trim()));
  }

  if (r.hourly) {
    const vals = r.hourly.filter(num);
    const lo = Math.min(...vals);
    const hi = Math.max(...vals);
    const wrap = el('div', 'bars');
    wrap.title = 'Average heart rate by hour, today';
    r.hourly.forEach((v, i) => {
      const bar = el('i', v === null ? 'empty' : i === new Date().getHours() ? 'last' : '');
      bar.style.height = v === null ? '6%' : `${25 + (hi === lo ? 40 : ((v - lo) / (hi - lo)) * 75)}%`;
      wrap.append(bar);
    });
    card.append(wrap, el('span', 'sub', 'today by hour'));
  }
  if (l?.source) card.append(el('span', 'src', l.source));
  return card;
}

function heroCard(byId: Map<HealthDataType, MetricResult>, metrics: Map<HealthDataType, Metric>, sleep: SleepSession[]): HTMLElement | null {
  const steps = byId.get('steps');
  if (!steps) return null;
  const n = steps.today ?? 0;
  const pct = Math.min(1, n / GOAL_STEPS);
  const C = 2 * Math.PI * 54;

  const ringBox = el('div', 'ring');
  ringBox.setAttribute('role', 'img');
  ringBox.setAttribute('aria-label', `${Math.round(n)} steps today, ${Math.round(pct * 100)} percent of the ${GOAL_STEPS.toLocaleString()} goal`);
  ringBox.innerHTML = `<svg viewBox="0 0 138 138"><circle class="track" cx="69" cy="69" r="54"/><circle class="fill" cx="69" cy="69" r="54" stroke-dasharray="${C}" stroke-dashoffset="${C}"/></svg>`;
  ringBox.append(el('div', 'ring-c', undefined, el('b', undefined, Math.round(n).toLocaleString()), el('span', undefined, pct >= 1 ? 'goal reached 🎉' : `of ${GOAL_STEPS.toLocaleString()} steps`)));
  requestAnimationFrame(() => requestAnimationFrame(() => ringBox.querySelector('.fill')?.setAttribute('stroke-dashoffset', String(C * (1 - pct)))));

  const list = el('div', 'mini-list');
  const mini = (emoji: string, big: string, small: string) =>
    list.append(el('div', 'mini', undefined, icon(emoji), el('div', undefined, undefined, el('b', undefined, big), el('span', undefined, small))));
  const dist = byId.get('distance');
  const cal = byId.get('calories');
  if (dist) mini('🚶', metrics.get('distance')!.format(dist.today ?? 0), 'walked today');
  if (cal) mini('🔥', metrics.get('calories')!.format(cal.today ?? 0), 'active energy');
  if (sleep[0]) mini('😴', fmtMinutes(sleep[0].asleepMinutes), 'last sleep');

  return el('section', 'hero', undefined, ringBox, list);
}

function stageBar(stages: Record<string, number>) {
  const entries = Object.entries(stages).filter(([, v]) => v > 0);
  if (!entries.length) return null;
  const bar = el('div', 'stages');
  bar.setAttribute('aria-hidden', 'true');
  for (const [k, v] of entries) {
    const seg = el('i', `st-${k}`);
    seg.style.flex = `${v} 1 0`;
    bar.append(seg);
  }
  const legend = el('div', 'legend');
  for (const [k, v] of entries) {
    const item = el('span', `st-${k}`, `${prettify(k)} ${fmtMinutes(v)}`);
    item.style.background = 'none';
    legend.append(item);
  }
  return [bar, legend];
}

function sleepSection(sessions: SleepSession[]): HTMLElement | null {
  if (!sessions.length) return null;
  const sec = el('section', 'group');
  sec.dataset.g = 'sleep';
  sec.append(el('h3', undefined, 'Sleep'));

  const last = sessions[0];
  const card = el('div', 'card');
  card.append(el('div', 'card-head', undefined, icon('😴'), el('span', 'label', 'Last sleep')));
  card.append(el('span', 'value', fmtMinutes(last.asleepMinutes)));
  card.append(el('span', 'sub', `${time(last.start)} to ${time(last.end)}${last.source ? ` · ${last.source}` : ''}`));
  const sb = stageBar(last.stages);
  if (sb) card.append(...sb);
  sec.append(card);

  if (sessions.length > 1) {
    const avg = sessions.reduce((a, s) => a + s.asleepMinutes, 0) / sessions.length;
    sec.append(el('p', 'sub', `Average ${fmtMinutes(avg)} over ${sessions.length} sessions`));
    const list = el('ul', 'list');
    for (const s of sessions.slice(1, 15)) {
      list.append(
        el('li', undefined, undefined,
          el('div', 'grow', undefined, el('b', undefined, dateTime(s.start)), el('small', undefined, `${time(s.start)} to ${time(s.end)}`)),
          el('span', 'end', fmtMinutes(s.asleepMinutes))),
      );
    }
    sec.append(list);
  }
  return sec;
}

function workoutSection(workouts: Workout[]): HTMLElement | null {
  if (!workouts.length) return null;
  const sec = el('section', 'group');
  sec.dataset.g = 'workout';
  sec.append(el('h3', undefined, 'Workouts'));
  const list = el('ul', 'list');
  for (const w of workouts.slice(0, 20)) {
    const bits = [
      w.totalDistance ? fmtDistance(w.totalDistance) : '',
      w.totalEnergyBurned ? `${Math.round(w.totalEnergyBurned)} kcal` : '',
      w.sourceName ?? '',
    ].filter(Boolean);
    list.append(
      el('li', undefined, undefined,
        icon(WORKOUT_ICONS[w.workoutType] ?? '🏅'),
        el('div', 'grow', undefined, el('b', undefined, prettify(w.workoutType)), el('small', undefined, [dateTime(w.startDate), ...bits].join(' · '))),
        el('span', 'end', fmtMinutes(w.duration / 60))),
    );
  }
  sec.append(list);
  return sec;
}

// ---------- places ----------
const NATIVE = Capacitor.isNativePlatform();
const unnamed = (n: number) => `Unnamed spot ${n}`;

function rangeFrom(nowMs: number) {
  return startOfDay(new Date(nowMs - (days - 1) * DAY)).getTime();
}

function labelRows(rows: Places.Row[]) {
  let n = 0;
  return new Map(rows.map((r) => [r.key, r.name ?? unnamed(++n)]));
}

function placesExport(): PlacesExport | undefined {
  if (!Places.state.enabled) return undefined;
  const nowMs = Date.now();
  const from = rangeFrom(nowMs);
  const rows = Places.totals(from, nowMs);
  const labels = labelRows(rows);
  const labelAt = (name: string | null, lat: number, lon: number) =>
    name ?? labels.get(rows.find((r) => !r.name && Places.dist(r, { lat, lon }) <= Places.MATCH)?.key ?? '') ?? 'Unnamed spot';
  const here = Places.now(nowMs);
  return {
    note: 'Places come from phone location: stays of 5+ minutes, accurate to a few minutes. Coordinates are not included.',
    now: here
      ? { place: here.row ? labels.get(here.row.key) ?? 'Unnamed spot' : 'Unnamed spot', since: new Date(here.since).toISOString(), minutes: Math.round((nowMs - here.since) / 60_000) }
      : null,
    totals: rows.map((r) => ({ place: labels.get(r.key)!, minutes: Math.round(r.ms / 60_000), visits: r.visits })),
    visits: Places.recentVisits(from, nowMs).map((v) => ({
      place: labelAt(v.place, v.lat, v.lon),
      start: new Date(v.start).toISOString(),
      end: new Date(v.end).toISOString(),
      minutes: Math.round((v.end - v.start) / 60_000),
    })),
  };
}

function placesNode(): HTMLElement {
  const sec = el('section', 'group');
  sec.dataset.g = 'places';
  sec.dataset.places = '1';
  sec.append(el('h3', undefined, 'Places'));

  if (!Places.state.enabled) {
    const card = el('div', 'card');
    card.append(el('div', 'card-head', undefined, icon('📍'), el('span', 'label', 'Where your time goes')));
    card.append(el('span', 'value', 'Home, work, gym…'));
    card.append(el('span', 'sub', 'See how long you spend at each place. It runs in the background with a notification, works out places on this phone only, and is accurate to a few minutes.'));
    const on = el('button', 'primary', 'Turn on place tracking');
    on.style.marginTop = '12px';
    on.addEventListener('click', () => { void enablePlaces(); });
    card.append(on);
    sec.append(card);
    return sec;
  }

  const nowMs = Date.now();
  const rows = Places.totals(rangeFrom(nowMs), nowMs);
  const labels = labelRows(rows);
  const here = Places.now(nowMs);

  const card = el('div', 'card');
  card.append(el('div', 'card-head', undefined, icon('📍'), el('span', 'label', 'Right now')));
  if (here) {
    card.append(el('span', 'value', here.row ? labels.get(here.row.key)! : 'New place'));
    card.append(el('span', 'sub', `since ${time(new Date(here.since).toISOString())} · ${fmtMinutes((nowMs - here.since) / 60_000)}`));
  } else {
    card.append(el('span', 'value', 'On the move'));
    card.append(el('span', 'sub', 'A place counts once you stay 5 minutes'));
  }
  sec.append(card);

  if (rows.length) {
    const max = rows[0].ms;
    const list = el('ul', 'list places');
    for (const r of rows) {
      const bar = el('i');
      bar.style.width = `${Math.max(4, (r.ms / max) * 100)}%`;
      const sub = [`${r.visits} ${r.visits === 1 ? 'visit' : 'visits'}`, r.hint ?? ''].filter(Boolean).join(' · ');
      const li = el('li', 'tap', undefined,
        icon(r.name ? '📍' : '❔'),
        el('div', 'grow', undefined, el('b', undefined, labels.get(r.key)!), el('small', undefined, sub), el('div', 'pbar', undefined, bar)),
        el('span', 'end', fmtMinutes(r.ms / 60_000)));
      li.tabIndex = 0;
      li.setAttribute('role', 'button');
      li.setAttribute('aria-label', `${labels.get(r.key)}, ${fmtMinutes(r.ms / 60_000)}. ${r.name ? 'Rename' : 'Name'} this place`);
      li.addEventListener('click', () => openName(r));
      li.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); openName(r); } });
      list.append(li);
    }
    sec.append(list, el('p', 'sub', 'Tap a place to name or rename it.'));
  } else {
    sec.append(el('p', 'note', 'No stays of 5 minutes or more in this range yet. Keep the app open in your recent apps and the places will appear as you move around.'));
  }

  const stop = el('button', 'secondary', 'Stop tracking');
  stop.addEventListener('click', () => { void Places.stopTracking().then(() => { refreshPlaces(); toast('Place tracking is off'); }); });
  const wipe = el('button', 'secondary', 'Delete place history');
  wipe.addEventListener('click', () => {
    if (!window.confirm('Delete all saved places and visit history from this phone?')) return;
    Places.clearAll();
    refreshPlaces();
  });
  const row = el('div', 'sheet-actions', undefined, stop, wipe);
  sec.append(el('details', 'more', undefined, el('summary', undefined, 'Place tracking settings'), row));
  return sec;
}

function refreshPlaces() {
  contentEl.querySelector('[data-places]')?.replaceWith(placesNode());
  if (lastExport) lastExport.places = placesExport();
}

async function enablePlaces() {
  if (!NATIVE && !DEMO) {
    toast('Place tracking only works in the Android app.');
    return;
  }
  try {
    await Places.startTracking(refreshPlaces, (m) => toast(m));
    toast('Place tracking is on. Keep the app in your recent apps.');
  } catch (e) {
    toast(`Could not start: ${errText(e)}`);
  }
  refreshPlaces();
}

const nameDialog = $<HTMLDialogElement>('nameSheet');
const nameInput = $<HTMLInputElement>('nameInput');
let nameTarget: { place: Places.Place | null; lat: number; lon: number } | null = null;

function openName(r: Places.Row) {
  nameTarget = { place: r.place, lat: r.lat, lon: r.lon };
  nameInput.value = r.name ?? '';
  $('nameTitle').textContent = r.name ? 'Rename place' : 'Name this place';
  nameDialog.showModal();
}

function saveNameNow() {
  if (nameTarget) Places.saveName(nameTarget, nameInput.value);
  nameDialog.close();
  refreshPlaces();
}

$('nameSave').addEventListener('click', saveNameNow);
$('nameCancel').addEventListener('click', () => nameDialog.close());
nameInput.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') saveNameNow(); });
$('chips').addEventListener('click', (ev) => {
  const chip = (ev.target as HTMLElement).closest<HTMLButtonElement>('button[data-name]');
  if (chip) nameInput.value = chip.dataset.name ?? '';
});

function skeleton(): Node[] {
  const grid = el('div', 'grid');
  grid.append(el('div', 'skel tall'), el('div', 'skel'), el('div', 'skel'), el('div', 'skel'), el('div', 'skel'));
  return [grid];
}

// ---------- app ----------
const READ_TYPES: HealthDataType[] = [...METRICS.map((m) => m.id), 'sleep', 'workouts'];
let days = 1;
let allowed = new Set<HealthDataType>();
let lastExport: ExportData | null = null;
let loading = false;

async function loadAll() {
  if (loading) return;
  loading = true;
  setStatus('Syncing…', 'busy');
  if (contentEl.childElementCount === 0) contentEl.replaceChildren(...skeleton());
  else contentEl.dataset.busy = 'true';

  try {
    const now = new Date();
    const from = startOfDay(new Date(now.getTime() - (days - 1) * DAY));
    const sleepFrom = new Date(Math.min(from.getTime(), now.getTime() - 36 * 3_600_000));
    const problems: string[] = [];

    const wanted = METRICS.filter((m) => allowed.has(m.id));
    const settled = await pool(wanted, 4, async (m) => {
      try {
        return await readMetric(m, from, now);
      } catch (e) {
        problems.push(`${m.label}: ${errText(e)}`);
        return null;
      }
    });
    const results = settled.filter((r): r is MetricResult => r !== null);

    let sleep: SleepSession[] = [];
    if (allowed.has('sleep')) {
      try { sleep = await readSleep(sleepFrom, now); } catch (e) { problems.push(`Sleep: ${errText(e)}`); }
    }
    let workouts: Workout[] = [];
    if (allowed.has('workouts')) {
      try { workouts = await readWorkouts(from, now); } catch (e) { problems.push(`Workouts: ${errText(e)}`); }
    }

    const metricById = new Map(METRICS.map((m) => [m.id, m]));
    const hasData = (r: MetricResult) => (r.kind === 'sum' ? (r.daily?.some((d) => d.value > 0) ?? false) : r.count > 0);
    const withData = results.filter(hasData);
    const resultById = new Map(withData.map((r) => [r.id, r]));
    const empty = results.filter((r) => !hasData(r)).map((r) => r.label);
    const denied = [...METRICS.filter((m) => !allowed.has(m.id)).map((m) => m.label), ...(['sleep', 'workouts'] as const).filter((t) => !allowed.has(t)).map(prettify)];

    const nodes: Node[] = [];
    const hero = heroCard(resultById, metricById, sleep);
    if (hero) nodes.push(hero);
    const sleepSec = sleepSection(sleep);
    if (sleepSec) nodes.push(sleepSec);
    nodes.push(placesNode());

    for (const g of GROUPS) {
      const rs = withData.filter((r) => r.group === g);
      if (!rs.length) continue;
      const sec = el('section', 'group');
      sec.dataset.g = GROUP_SLUG[g];
      sec.append(el('h3', undefined, g));
      const grid = el('div', 'grid');
      for (const r of rs) grid.append(metricCard(r, metricById.get(r.id)!, days, now));
      if (g === 'Heart & stress') {
        grid.append(el('p', 'note', '🧠 Stress scores from Samsung Health, Fitbit or Garmin are not available: Health Connect has no stress type. HRV and resting heart rate are the closest signals.'));
      }
      sec.append(grid);
      nodes.push(sec);
    }
    const workoutSec = workoutSection(workouts);
    if (workoutSec) nodes.push(workoutSec);

    if (!nodes.length) {
      nodes.push(el('p', 'note', 'No data found in this range yet. Make sure your watch or fitness app is writing to Health Connect, then refresh.'));
    }

    const foot: string[] = [];
    if (empty.length) foot.push(`No data in this range: ${empty.join(', ')}.`);
    if (denied.length) foot.push(`Not allowed: ${denied.join(', ')}.`);
    if (problems.length) foot.push(`Errors: ${problems.join('; ')}`);
    if (foot.length) {
      const d = el('details', 'more', undefined, el('summary', undefined, 'Not shown'), ...foot.map((f) => el('p', undefined, f)));
      nodes.push(d);
    }

    contentEl.replaceChildren(...nodes);
    lastExport = { source: 'Android Health Connect', generatedAt: now.toISOString(), rangeDays: days, metrics: results, sleep, workouts, places: placesExport() };
    show($('copy'), true);
    setStatus(`Updated ${now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}${DEMO ? ' · demo data' : ''}`, 'ok');
  } finally {
    delete contentEl.dataset.busy;
    loading = false;
  }
}

async function afterAuth(readAuthorized: HealthDataType[]) {
  allowed = new Set(readAuthorized);
  const ready = allowed.size > 0;
  show($('onboard'), !ready);
  show($('rangeWrap'), ready);
  show($('refresh'), ready);
  if (!ready) {
    contentEl.replaceChildren();
    setStatus('Not connected yet', 'idle');
    return false;
  }
  await loadAll();
  return true;
}

async function connect() {
  const status = await Health.requestAuthorization({ read: READ_TYPES, write: [] });
  if (!(await afterAuth(status.readAuthorized))) toast('Nothing was allowed. Tap Connect and allow the data you want.');
}

// ---------- copy for an AI agent ----------
const sheet = $<HTMLDialogElement>('sheet');
const preview = $<HTMLTextAreaElement>('preview');
const copyBtn = $<HTMLButtonElement>('copyNow');
const shareBtn = $<HTMLButtonElement>('shareNow');
const askBox = $<HTMLInputElement>('withAsk');
const placesBox = $<HTMLInputElement>('withPlaces');
let format: ExportFormat = 'text';

function fillPreview() {
  if (!lastExport) return;
  preview.value = buildExport(lastExport, format, { ask: askBox.checked, places: placesBox.checked && !!lastExport.places });
  const wordCount = preview.value.split(/\s+/).filter(Boolean).length;
  $('previewMeta').textContent = `About ${approxTokens(preview.value).toLocaleString()} tokens, ${wordCount.toLocaleString()} words. You can edit the text before copying.`;
  for (const b of $('fmt').querySelectorAll<HTMLButtonElement>('button')) b.setAttribute('aria-pressed', String(b.dataset.fmt === format));
}

function openSheet() {
  if (!lastExport) return;
  $('sheetRange').textContent = lastExport.rangeDays === 1 ? 'today' : `the last ${lastExport.rangeDays} days`;
  copyBtn.textContent = 'Copy';
  lastExport.places = placesExport();
  $('placesRow').hidden = !lastExport.places;
  fillPreview();
  sheet.showModal();
  preview.scrollTop = 0;
}

async function copyNow() {
  let ok = false;
  try {
    // The native clipboard is the most reliable inside the Android WebView; browsers use the web API.
    if (Capacitor.isNativePlatform()) await Clipboard.write({ string: preview.value });
    else await navigator.clipboard.writeText(preview.value);
    ok = true;
  } catch {
    preview.focus();
    preview.select();
    try { ok = document.execCommand('copy'); } catch { /* fall through */ }
  }
  if (ok) {
    copyBtn.textContent = 'Copied ✓';
    toast('Copied. Paste it into your AI app.');
  } else {
    toast('Could not copy. Press and hold the text, then choose Copy.');
  }
}

async function shareNow() {
  try {
    await Share.share({ title: 'My health data', text: preview.value, dialogTitle: 'Send to an AI app' });
  } catch (e) {
    // Closing the share sheet counts as a cancel, not an error.
    if (!/cancel/i.test(errText(e))) toast(`Could not share: ${errText(e)}`);
  }
}

$('copy').addEventListener('click', openSheet);
$('sheetClose').addEventListener('click', () => sheet.close());
sheet.addEventListener('click', (ev) => { if (ev.target === sheet) sheet.close(); });
askBox.addEventListener('change', fillPreview);
placesBox.addEventListener('change', fillPreview);
$('fmt').addEventListener('click', (ev) => {
  const btn = (ev.target as HTMLElement).closest<HTMLButtonElement>('button[data-fmt]');
  if (!btn) return;
  format = btn.dataset.fmt as ExportFormat;
  copyBtn.textContent = 'Copy';
  fillPreview();
});
copyBtn.addEventListener('click', () => { void copyNow(); });
shareBtn.addEventListener('click', () => { void shareNow(); });
void Share.canShare().then((r) => { shareBtn.hidden = !r.value; }).catch(() => { /* no share sheet here */ });

const guard = (fn: () => Promise<unknown>) => () => {
  fn().catch((e) => { setStatus(`Error: ${errText(e)}`, 'err'); });
};

$('connect').addEventListener('click', guard(connect));
$('refresh').addEventListener('click', guard(loadAll));
$('range').addEventListener('click', (ev) => {
  const btn = (ev.target as HTMLElement).closest<HTMLButtonElement>('button[data-days]');
  if (!btn) return;
  days = Number(btn.dataset.days);
  for (const b of $('range').querySelectorAll('button')) b.setAttribute('aria-pressed', String(b === btn));
  guard(loadAll)();
});

async function init() {
  $('date').textContent = new Date().toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  if (DEMO) Places.seedDemo();
  else {
    Places.load();
    // Resume tracking after the app was closed. Needs the app in the foreground, which it is right now.
    if (Places.state.enabled && NATIVE) void Places.startTracking(refreshPlaces, (m) => toast(m)).catch(() => { /* shown as off */ });
    else if (!NATIVE) Places.state.enabled = false;
  }
  const availability = await Health.isAvailable();
  if (!availability.available) {
    const note = $('unavailable');
    note.textContent = availability.reason ?? 'Health Connect is not available on this device.';
    show(note, true);
    setStatus('Health Connect unavailable', 'err');
    return;
  }
  // If permission was already granted on an earlier run, load straight away.
  const status = await Health.checkAuthorization({ read: READ_TYPES, write: [] });
  await afterAuth(status.readAuthorized);
}

void init().catch((e) => setStatus(`Error: ${errText(e)}`, 'err'));
