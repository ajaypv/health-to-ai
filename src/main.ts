import { Health } from '@capgo/capacitor-health';
import type { HealthDataType, HealthSample, SleepStage, Workout } from '@capgo/capacitor-health';
import { GROUPS, METRICS, fmtDistance, fmtMinutes } from './metrics';
import type { Metric } from './metrics';

// ---------- small helpers ----------
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const statusEl = $('status');
const contentEl = $('content');
const jsonEl = $<HTMLTextAreaElement>('json');
const show = (e: HTMLElement, on: boolean) => { e.hidden = !on; };
const setStatus = (msg: string) => { statusEl.textContent = msg; };
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

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
  return `${x.getFullYear()}-${x.getMonth() + 1}-${x.getDate()}`;
};
const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const dateTime = (iso: string) =>
  new Date(iso).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

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
interface MetricResult {
  id: HealthDataType;
  label: string;
  group: Metric['group'];
  kind: Metric['kind'];
  count: number;
  /** sum metrics: total per local day, and today's total */
  daily?: { date: string; value: number }[];
  today?: number;
  /** stat/latest metrics */
  latest?: { value: number; text?: string; at: string; source?: string };
  avg?: number;
  min?: number;
  max?: number;
  /** heart rate only: average bpm per hour of today (index = hour, null = no data) */
  hourly?: (number | null)[];
}

interface SleepSession {
  start: string;
  end: string;
  totalMinutes: number;
  asleepMinutes: number;
  stages: Record<string, number>;
  source?: string;
}

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
function metricCard(r: MetricResult, m: Metric, days: number): HTMLElement {
  const card = el('div', 'card');
  card.append(el('span', 'label', r.label));

  if (m.kind === 'sum') {
    card.append(el('span', 'value', m.format(r.today ?? 0)));
    const sum = (r.daily ?? []).reduce((a, d) => a + d.value, 0);
    card.append(el('span', 'sub', days === 1 ? 'today' : `today · avg ${m.format(sum / days)} / day`));
    return card;
  }

  const l = r.latest;
  card.append(el('span', 'value', l ? (l.text ?? m.format(l.value)) : '–'));
  const bits: string[] = [];
  if (l) bits.push(dateTime(l.at));
  if (r.kind === 'stat' && num(r.avg) && num(r.min) && num(r.max)) {
    bits.push(`avg ${m.format(r.avg)} · ${m.format(r.min)}–${m.format(r.max)}`);
  }
  if (l?.source) bits.push(l.source);
  for (const b of bits) card.append(el('span', 'sub', b));

  if (r.hourly) {
    const vals = r.hourly.filter(num);
    const lo = Math.min(...vals);
    const hi = Math.max(...vals);
    const spark = el('div', 'spark');
    spark.title = 'Average heart rate by hour, today';
    for (const v of r.hourly) {
      const bar = el('i');
      bar.style.height = v === null ? '2px' : `${20 + (hi === lo ? 40 : ((v - lo) / (hi - lo)) * 80)}%`;
      if (v === null) bar.style.opacity = '.2';
      spark.append(bar);
    }
    card.append(spark, el('span', 'sub', 'today by hour'));
  }
  return card;
}

function listItem(title: string, detail: string, right: string) {
  const left = el('span', undefined, title, ...(detail ? [el('small', undefined, detail)] : []));
  return el('li', undefined, undefined, left, el('span', undefined, right));
}

function sleepSection(sessions: SleepSession[]): HTMLElement[] {
  if (!sessions.length) return [];
  const last = sessions[0];
  const avg = sessions.reduce((a, s) => a + s.asleepMinutes, 0) / sessions.length;
  const grid = el('div', 'grid');
  const a = el('div', 'card', undefined, el('span', 'label', 'Last sleep'), el('span', 'value', fmtMinutes(last.asleepMinutes)), el('span', 'sub', `${time(last.start)} – ${time(last.end)}`));
  grid.append(a);
  if (sessions.length > 1) {
    grid.append(el('div', 'card', undefined, el('span', 'label', 'Average sleep'), el('span', 'value', fmtMinutes(avg)), el('span', 'sub', `${sessions.length} sessions`)));
  }
  const list = el('ul');
  for (const s of sessions.slice(0, 14)) {
    const stages = Object.entries(s.stages).map(([k, v]) => `${k} ${fmtMinutes(v)}`).join(' · ');
    list.append(listItem(dateTime(s.start), [stages, s.source].filter(Boolean).join(' · '), fmtMinutes(s.asleepMinutes)));
  }
  return [el('h2', undefined, 'Sleep'), grid, list];
}

function workoutSection(workouts: Workout[]): HTMLElement[] {
  if (!workouts.length) return [];
  const list = el('ul');
  for (const w of workouts.slice(0, 20)) {
    const bits = [
      w.totalDistance ? fmtDistance(w.totalDistance) : '',
      w.totalEnergyBurned ? `${Math.round(w.totalEnergyBurned)} kcal` : '',
      w.sourceName ?? '',
    ].filter(Boolean);
    list.append(listItem(`${w.workoutType} · ${dateTime(w.startDate)}`, bits.join(' · '), fmtMinutes(w.duration / 60)));
  }
  return [el('h2', undefined, 'Workouts'), list];
}

// ---------- app ----------
const READ_TYPES: HealthDataType[] = [...METRICS.map((m) => m.id), 'sleep', 'workouts'];
let days = 1;
let allowed = new Set<HealthDataType>();
let lastExport: unknown = null;

async function loadAll() {
  setStatus('Reading…');
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

  const byMetric = new Map(METRICS.map((m) => [m.id, m]));
  const hasData = (r: MetricResult) => (r.kind === 'sum' ? (r.daily?.some((d) => d.value > 0) ?? false) : r.count > 0);
  const withData = results.filter(hasData);
  const empty = results.filter((r) => !hasData(r)).map((r) => r.label);
  const denied = METRICS.filter((m) => !allowed.has(m.id)).map((m) => m.label);

  const nodes: Node[] = [];
  for (const g of GROUPS) {
    const rs = withData.filter((r) => r.group === g);
    if (!rs.length) continue;
    nodes.push(el('h2', undefined, g));
    const grid = el('div', 'grid');
    for (const r of rs) grid.append(metricCard(r, byMetric.get(r.id)!, days));
    nodes.push(grid);
    if (g === 'Heart & stress') {
      nodes.push(el('p', 'note', 'Stress: Health Connect has no stress-score type, so stress scores from Samsung Health, Fitbit or Garmin are not shared with apps. HRV and resting heart rate are the closest signals available.'));
    }
  }
  nodes.push(...sleepSection(sleep), ...workoutSection(workouts));

  const foot: string[] = [];
  if (empty.length) foot.push(`No data in range: ${empty.join(', ')}.`);
  if (denied.length) foot.push(`Not allowed: ${denied.join(', ')}.`);
  if (problems.length) foot.push(`Errors: ${problems.join('; ')}`);
  if (foot.length) nodes.push(el('h2', undefined, 'Not shown'), el('p', 'sub', foot.join(' ')));

  contentEl.replaceChildren(...nodes);
  lastExport = { generatedAt: now.toISOString(), rangeDays: days, metrics: results, sleep, workouts };
  show($('copy'), true);
  setStatus(`Updated ${now.toLocaleTimeString()}`);
}

async function afterAuth(readAuthorized: HealthDataType[]) {
  allowed = new Set(readAuthorized);
  if (!allowed.size) {
    setStatus('Nothing allowed yet. Tap Connect and allow the data you want to see.');
    return false;
  }
  show($('range'), true);
  await loadAll();
  return true;
}

async function connect() {
  const status = await Health.requestAuthorization({ read: READ_TYPES, write: [] });
  await afterAuth(status.readAuthorized);
}

async function copyJson() {
  const text = JSON.stringify(lastExport, null, 2);
  jsonEl.value = text;
  show(jsonEl, true);
  try {
    await navigator.clipboard.writeText(text);
    setStatus('Copied all data as JSON.');
  } catch {
    jsonEl.select();
    setStatus('Select the text below and copy it.');
  }
}

const guard = (fn: () => Promise<unknown>) => () => void fn().catch((e) => setStatus(`Error: ${errText(e)}`));

$('connect').addEventListener('click', guard(connect));
$('refresh').addEventListener('click', guard(loadAll));
$('copy').addEventListener('click', guard(copyJson));
$('range').addEventListener('click', (ev) => {
  const btn = (ev.target as HTMLElement).closest<HTMLButtonElement>('button[data-days]');
  if (!btn) return;
  days = Number(btn.dataset.days);
  for (const b of $('range').querySelectorAll('button')) b.setAttribute('aria-pressed', String(b === btn));
  guard(loadAll)();
});

async function init() {
  const availability = await Health.isAvailable();
  if (!availability.available) {
    setStatus(availability.reason ?? 'Health Connect is not available on this device.');
    return;
  }
  show($('connect'), true);
  show($('refresh'), true);
  // If permission was already granted on an earlier run, load straight away.
  const status = await Health.checkAuthorization({ read: READ_TYPES, write: [] });
  if (!(await afterAuth(status.readAuthorized))) setStatus('Health Connect is ready. Tap Connect.');
}

void init().catch((e) => setStatus(`Error: ${errText(e)}`));
