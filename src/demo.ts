/**
 * Fake Health Connect, used only when the app is opened in a normal browser with `?demo` in the URL.
 * It lets you preview and test the screen on a computer. The Android app never uses it.
 */
import type { Health } from '@capgo/capacitor-health';

type Api = typeof Health;
type Samples = Awaited<ReturnType<Api['readSamples']>>['samples'];
type Aggregated = Awaited<ReturnType<Api['queryAggregated']>>['samples'];

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const rand = (seed: number) => {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return x - Math.floor(x);
};
const dayIndex = (d: Date) => Math.floor(new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() / DAY);
const between = (seed: number, lo: number, hi: number) => lo + rand(seed) * (hi - lo);
const SRC = 'Demo Watch';

/** Per-day totals, shrunk for today so the day looks partly done. */
function dayTotal(id: string, day: number, isToday: boolean, now: Date) {
  const f = isToday ? Math.max(0.1, (now.getHours() * 60 + now.getMinutes()) / 1440) : 1;
  const s = day * 7 + id.length;
  const v: Record<string, number> = {
    steps: between(s, 4500, 12500),
    distance: between(s, 3200, 9500),
    calories: between(s, 220, 620),
    dietaryEnergyConsumed: between(s, 1500, 2600),
    dietaryProtein: between(s, 50, 130),
    dietaryWater: between(s, 1, 3),
  };
  return (v[id] ?? 0) * f;
}

const iso = (d: Date | number) => new Date(d).toISOString();

export const demoHealth: Pick<Api, 'isAvailable' | 'checkAuthorization' | 'requestAuthorization' | 'readSamples' | 'queryAggregated' | 'queryWorkouts'> = {
  async isAvailable() {
    return { available: true, platform: 'android' };
  },
  async checkAuthorization(o) {
    // `?demo&fresh` previews the first-run "Connect" screen.
    const fresh = location.search.includes('fresh');
    return { readAuthorized: fresh ? [] : (o.read ?? []), readDenied: [], writeAuthorized: [], writeDenied: [] };
  },
  async requestAuthorization(o) {
    return { readAuthorized: o.read ?? [], readDenied: [], writeAuthorized: [], writeDenied: [] };
  },

  async queryAggregated(o) {
    const start = new Date(o.startDate ?? Date.now() - DAY);
    const end = new Date(o.endDate ?? Date.now());
    const now = new Date();
    const out: Aggregated = [];
    const aggs = Array.isArray(o.aggregation) ? o.aggregation : [o.aggregation ?? 'sum'];

    if (o.bucket === 'hour') {
      let t = new Date(start.getFullYear(), start.getMonth(), start.getDate(), start.getHours());
      for (; t < end; t = new Date(+t + HOUR)) {
        const h = t.getHours();
        const bpm = 58 + (h >= 7 && h <= 22 ? 14 : 0) + (h === 18 ? 30 : 0) + between(+t / HOUR, 0, 8);
        out.push({ startDate: iso(t), endDate: iso(+t + HOUR), value: bpm, values: { average: bpm }, unit: 'bpm' });
      }
      return { samples: out };
    }

    for (let t = new Date(start.getFullYear(), start.getMonth(), start.getDate()); t < end; t = new Date(+t + DAY)) {
      const d = dayIndex(t);
      const today = d === dayIndex(now);
      if (o.dataType === 'heartRate' || o.dataType === 'restingHeartRate') {
        const base = o.dataType === 'heartRate' ? between(d, 66, 76) : between(d, 56, 62);
        const values = { average: base, min: base - 14, max: base + (o.dataType === 'heartRate' ? 62 : 6) };
        out.push({ startDate: iso(t), endDate: iso(+t + DAY), value: values[aggs[0] as 'average'], values: Object.fromEntries(aggs.map((a) => [a, values[a as 'average']])), unit: 'bpm' });
      } else {
        const v = dayTotal(o.dataType, d, today, now);
        out.push({ startDate: iso(t), endDate: iso(+t + DAY), value: v, values: { sum: v }, unit: 'count' });
      }
    }
    return { samples: out };
  },

  async readSamples(o) {
    const now = new Date();
    const start = +new Date(o.startDate ?? now.getTime() - DAY);
    const samples: Samples = [];
    const base = { sourceName: SRC, sourceId: 'demo.watch' };
    const span = Math.max(HOUR, now.getTime() - start);

    if (o.dataType === 'sleep') {
      const nights = Math.max(1, Math.ceil(span / DAY));
      for (let n = 0; n < Math.min(nights, 30); n++) {
        const wake = new Date(now.getFullYear(), now.getMonth(), now.getDate() - n, 6, 40 + Math.round(between(n, 0, 40)));
        if (+wake > +now) continue;
        const dur = Math.round(between(n + 3, 380, 510));
        const begin = +wake - dur * 60_000;
        if (begin < start - 12 * HOUR) continue;
        const parts: [string, number][] = [['light', 0.5], ['deep', 0.17], ['rem', 0.22], ['awake', 0.11]];
        let t = begin;
        const stages = parts.map(([stage, share]) => {
          const m = Math.round(dur * share);
          const st = { startDate: iso(t), endDate: iso(t + m * 60_000), stage: stage as 'light', durationMinutes: m };
          t += m * 60_000;
          return st;
        });
        samples.push({ ...base, dataType: 'sleep', value: dur, unit: 'minute', startDate: iso(begin), endDate: iso(wake), sleepState: 'asleep', hasStageData: true, stages });
      }
      return { samples };
    }

    const units: Record<string, [number, number, string]> = {
      heartRate: [58, 110, 'bpm'], restingHeartRate: [56, 62, 'bpm'], heartRateVariability: [28, 78, 'millisecond'],
      oxygenSaturation: [94, 99, 'percent'], respiratoryRate: [13, 17, 'bpm'], vo2Max: [41, 44, 'mL/min/kg'],
      weight: [71.5, 72.4, 'kilogram'], height: [178, 178, 'centimeter'], bodyFat: [17, 19, 'percent'],
      bodyTemperature: [36.4, 36.9, 'celsius'], basalCalories: [1650, 1700, 'kilocalorie'], flightsClimbed: [1, 6, 'count'],
      totalCalories: [1800, 2600, 'kilocalorie'], mindfulness: [5, 20, 'minute'],
    };

    if (o.dataType === 'bloodPressure') {
      samples.push({ ...base, dataType: 'bloodPressure', value: 118, unit: 'mmHg', startDate: iso(now.getTime() - 2 * DAY), endDate: iso(now.getTime() - 2 * DAY), systolic: 118, diastolic: 76 });
      return { samples };
    }
    const u = units[o.dataType];
    if (!u) return { samples }; // e.g. cycling, glucose, basal temperature: "no data"

    const count = o.dataType === 'heartRate' ? 200 : ['weight', 'height', 'bodyFat', 'bodyTemperature', 'vo2Max', 'basalCalories'].includes(o.dataType) ? 3 : 12;
    const gap = o.dataType === 'heartRate' ? 5 * 60_000 : Math.min(span, 30 * DAY) / count;
    for (let i = 0; i < count; i++) {
      const at = now.getTime() - 20 * 60_000 - i * gap;
      if (at < start) break;
      samples.push({ ...base, dataType: o.dataType, value: between(i + o.dataType.length, u[0], u[1]), unit: u[2] as 'bpm', startDate: iso(at), endDate: iso(at), deviceType: 'watch' });
    }
    return { samples };
  },

  async queryWorkouts() {
    const now = Date.now();
    const mk = (hoursAgo: number, mins: number, type: 'running', km: number, kcal: number) => ({
      workoutType: type, duration: mins * 60, totalDistance: km * 1000, totalEnergyBurned: kcal,
      startDate: iso(now - hoursAgo * HOUR), endDate: iso(now - hoursAgo * HOUR + mins * 60_000), sourceName: SRC,
    });
    return {
      workouts: [
        mk(20, 38, 'running', 5.4, 410),
        { ...mk(70, 55, 'running', 0, 280), workoutType: 'strengthTraining' as 'running', totalDistance: 0 },
        { ...mk(120, 62, 'running', 18.2, 520), workoutType: 'cycling' as 'running' },
      ],
    };
  },
};
