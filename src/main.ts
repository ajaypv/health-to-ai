import { Health } from '@capgo/capacitor-health';

const TYPES = ['steps', 'distance', 'sleep'] as const;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const statusEl = $('status');
const connectBtn = $<HTMLButtonElement>('connect');
const refreshBtn = $<HTMLButtonElement>('refresh');

const show = (el: HTMLElement, on: boolean) => { el.hidden = !on; };
const setStatus = (msg: string) => { statusEl.textContent = msg; };

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const fmtHours = (min: number) => `${Math.floor(min / 60)}h ${Math.round(min % 60)}m`;
const fmtDistance = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`);

async function loadSteps(from: Date, to: Date) {
  const res = await Health.queryAggregated({
    dataType: 'steps',
    startDate: from.toISOString(),
    endDate: to.toISOString(),
    bucket: 'day',
    aggregation: 'sum',
  });
  return res.samples;
}

async function loadAll() {
  setStatus('Reading…');
  const now = new Date();
  const today = startOfDay(now);
  const weekStart = new Date(today.getTime() - 6 * 86_400_000);

  // Steps: one bucket per day for the last 7 days (today is the last one).
  const week = await loadSteps(weekStart, now);
  const todaySteps = week.length ? week[week.length - 1].value : 0;
  $('steps').textContent = Math.round(todaySteps).toLocaleString();

  const weekEl = $('week');
  weekEl.replaceChildren(
    ...week.map((s) => {
      const li = document.createElement('li');
      const day = new Date(s.startDate).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
      li.append(day, Math.round(s.value).toLocaleString());
      return li;
    }),
  );
  show($('weekSection'), true);

  // Walking distance for today (metres).
  const dist = await Health.queryAggregated({
    dataType: 'distance',
    startDate: today.toISOString(),
    endDate: now.toISOString(),
    bucket: 'day',
    aggregation: 'sum',
  });
  $('distance').textContent = fmtDistance(dist.samples.reduce((a, s) => a + s.value, 0));

  // Sleep can't be aggregated: read sessions from the last 36 hours.
  const sleep = await Health.readSamples({
    dataType: 'sleep',
    startDate: new Date(now.getTime() - 36 * 3_600_000).toISOString(),
    endDate: now.toISOString(),
    ascending: false,
  });
  const asleepMin = sleep.samples
    .filter((s) => !s.sleepState || !['awake', 'inBed'].includes(s.sleepState))
    .reduce((a, s) => a + s.value, 0);
  $('sleep').textContent = sleep.samples.length ? fmtHours(asleepMin) : '–';

  $('sleepList').replaceChildren(
    ...sleep.samples.map((s) => {
      const li = document.createElement('li');
      const t = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      li.append(`${t(s.startDate)} – ${t(s.endDate)} · ${s.sourceName ?? 'unknown app'}`, fmtHours(s.value));
      return li;
    }),
  );
  show($('sleepSection'), sleep.samples.length > 0);

  show($('cards'), true);
  setStatus(`Updated ${now.toLocaleTimeString()}`);
}

async function connect() {
  const status = await Health.requestAuthorization({ read: [...TYPES], write: [] });
  const denied = status.readDenied ?? [];
  if (denied.length === TYPES.length) {
    setStatus('Permission denied. Allow steps, distance and sleep in Health Connect.');
    return;
  }
  if (denied.length) setStatus(`Some data not allowed: ${denied.join(', ')}`);
  await loadAll();
}

async function init() {
  const availability = await Health.isAvailable();
  if (!availability.available) {
    setStatus(availability.reason ?? 'Health Connect is not available on this device.');
    return;
  }
  setStatus('Health Connect is ready.');
  show(connectBtn, true);
  show(refreshBtn, true);
}

connectBtn.addEventListener('click', () => void connect().catch((e) => setStatus(`Error: ${e?.message ?? e}`)));
refreshBtn.addEventListener('click', () => void loadAll().catch((e) => setStatus(`Error: ${e?.message ?? e}`)));
void init().catch((e) => setStatus(`Error: ${e?.message ?? e}`));
