/**
 * Turns what the app read into text that can be pasted into any AI agent:
 * a readable summary (cheap to read, good for chat) or the full JSON.
 */
import { GROUPS, METRICS, fmtDistance, fmtMinutes } from './metrics';
import type { ExportData, MetricResult } from './types';

export type ExportFormat = 'text' | 'json';

const ASK_TEXT =
  'Here is my health data from Android Health Connect (read-only, from my phone and watch). ' +
  'Please act as a careful health and fitness coach: summarise how I am doing, point out trends or anything unusual, ' +
  'and suggest 3 practical things to try this week. This is not a medical diagnosis, so tell me if anything is worth asking a doctor about.';

const ASK_JSON =
  'Here is my health data from Android Health Connect as JSON (dates are local to my phone; durations are in minutes unless a unit is given). ' +
  'Please act as a careful health and fitness coach: summarise how I am doing, point out trends or anything unusual, ' +
  'and suggest 3 practical things to try this week. This is not a medical diagnosis, so tell me if anything is worth asking a doctor about.';

const pad = (n: number) => String(n).padStart(2, '0');
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const dayLabel = (d: Date) => `${WEEKDAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
const keyLabel = (key: string) => {
  const [y, m, d] = key.split('-').map(Number);
  return dayLabel(new Date(y, m - 1, d));
};
const clock = (iso: string) => {
  const d = new Date(iso);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const when = (iso: string) => `${dayLabel(new Date(iso))} ${clock(iso)}`;
const words = (s: string) => {
  const t = s.replace(/([A-Z])/g, ' $1').toLowerCase();
  return t.charAt(0).toUpperCase() + t.slice(1);
};

const metricById = new Map(METRICS.map((m) => [m.id, m]));
const hasData = (r: MetricResult) => (r.kind === 'sum' ? (r.daily?.some((d) => d.value > 0) ?? false) : r.count > 0);

function metricLine(r: MetricResult, rangeDays: number): string {
  const m = metricById.get(r.id)!;
  if (r.kind === 'sum') {
    const parts = [`${r.label}: ${m.format(r.today ?? 0)} today`];
    if (rangeDays > 1) {
      const daily = [...(r.daily ?? [])].sort((a, b) => a.date.localeCompare(b.date));
      const total = daily.reduce((a, d) => a + d.value, 0);
      parts.push(`average ${m.format(total / rangeDays)} a day over ${rangeDays} days`);
      parts.push(`by day: ${daily.map((d) => `${keyLabel(d.date)} ${m.format(d.value)}`).join(', ')}`);
    }
    return `- ${parts.join(' · ')}`;
  }
  const parts = [r.label + ':'];
  const l = r.latest;
  if (l) parts.push(`latest ${l.text ?? m.format(l.value)} (${when(l.at)})`);
  if (r.kind === 'stat' && r.avg !== undefined && r.min !== undefined && r.max !== undefined) {
    parts.push(`· average ${m.format(r.avg)} · lowest ${m.format(r.min)} · highest ${m.format(r.max)}`);
  }
  if (r.hourly) {
    const hours = r.hourly.map((v, h) => (v === null ? null : `${pad(h)}h ${Math.round(v)}`)).filter(Boolean);
    parts.push(`· average by hour today: ${hours.join(', ')}`);
  }
  return `- ${parts.join(' ')}`;
}

function summary(data: ExportData): string {
  const now = new Date(data.generatedAt);
  const range = data.rangeDays === 1 ? 'today so far' : `the last ${data.rangeDays} days (today included)`;
  const out: string[] = [
    '# Health data (Android Health Connect)',
    `Exported: ${dayLabel(now)} ${clock(data.generatedAt)} · Covers: ${range}`,
    'Rarely recorded values such as weight or blood pressure show the most recent reading from the last 30 days.',
  ];

  const withData = data.metrics.filter(hasData);
  for (const g of GROUPS) {
    const rs = withData.filter((r) => r.group === g);
    if (!rs.length) continue;
    out.push('', `## ${g}`, ...rs.map((r) => metricLine(r, data.rangeDays)));
  }

  if (data.sleep.length) {
    out.push('', '## Sleep');
    for (const s of data.sleep.slice(0, 14)) {
      const stages = Object.entries(s.stages).filter(([, v]) => v > 0).map(([k, v]) => `${k} ${fmtMinutes(v)}`);
      out.push(`- ${dayLabel(new Date(s.start))} ${clock(s.start)} to ${clock(s.end)}: asleep ${fmtMinutes(s.asleepMinutes)} (session ${fmtMinutes(s.totalMinutes)})${stages.length ? ` · ${stages.join(', ')}` : ''}`);
    }
  }

  if (data.workouts.length) {
    out.push('', '## Workouts');
    for (const w of data.workouts.slice(0, 20)) {
      const bits = [
        words(w.workoutType),
        when(w.startDate),
        fmtMinutes(w.duration / 60),
        w.totalDistance ? fmtDistance(w.totalDistance) : '',
        w.totalEnergyBurned ? `${Math.round(w.totalEnergyBurned)} kcal` : '',
      ].filter(Boolean);
      out.push(`- ${bits.join(' · ')}`);
    }
  }

  const fd = data.food;
  if (fd && fd.meals.length) {
    out.push('', '## Food log (meals I logged in the app)');
    for (const d of fd.byDay) out.push(`- ${keyLabel(d.date)}: ${Math.round(d.kcal)} kcal · protein ${Math.round(d.protein)} g · carbs ${Math.round(d.carbs)} g · fat ${Math.round(d.fat)} g`);
    out.push('- Meals:');
    for (const m of fd.meals) out.push(`  - ${dayLabel(new Date(m.at))} ${clock(m.at)}: ${m.name}, ${Math.round(m.kcal)} kcal (protein ${Math.round(m.protein)} g, carbs ${Math.round(m.carbs)} g, fat ${Math.round(m.fat)} g)`);
    out.push(`- ${fd.note}`);
  }

  const pl = data.places;
  if (pl) {
    out.push('', '## Places (where I spent my time)');
    if (pl.now) out.push(`- Right now: at ${pl.now.place} since ${clock(pl.now.since)} (${fmtMinutes(pl.now.minutes)})`);
    for (const t of pl.totals) out.push(`- ${t.place}: ${fmtMinutes(t.minutes)} over ${t.visits} ${t.visits === 1 ? 'visit' : 'visits'}`);
    if (pl.visits.length) {
      out.push('- Visits:');
      for (const v of pl.visits) out.push(`  - ${dayLabel(new Date(v.start))} ${clock(v.start)} to ${clock(v.end)}: ${v.place} (${fmtMinutes(v.minutes)})`);
    }
    out.push(`- ${pl.note}`);
  }

  const empty = data.metrics.filter((r) => !hasData(r)).map((r) => r.label);
  out.push('', '## Notes');
  if (empty.length) out.push(`- No data in this range: ${empty.join(', ')}.`);
  out.push('- Health Connect has no stress score. HRV and resting heart rate are the closest signals.');
  return out.join('\n');
}

export interface ExportOptions { ask: boolean; places: boolean }

export function buildExport(source: ExportData, format: ExportFormat, opts: ExportOptions): string {
  const data = opts.places ? source : { ...source, places: undefined };
  const body = format === 'json' ? JSON.stringify(data, null, 1) : summary(data);
  if (!opts.ask) return body;
  return `${format === 'json' ? ASK_JSON : ASK_TEXT}\n\n${body}`;
}

/** Rough size so people know whether it fits in a chat box. About 4 characters per token. */
export const approxTokens = (text: string) => Math.ceil(text.length / 4);
