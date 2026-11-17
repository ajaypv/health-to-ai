import type { HealthDataType, Workout } from '@capgo/capacitor-health';
import type { Metric } from './metrics';

export interface MetricResult {
  id: HealthDataType;
  label: string;
  group: Metric['group'];
  kind: Metric['kind'];
  count: number;
  /** sum metrics: total per local day (YYYY-MM-DD), and today's total */
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

export interface SleepSession {
  start: string;
  end: string;
  totalMinutes: number;
  asleepMinutes: number;
  stages: Record<string, number>;
  source?: string;
}

/** Time at places. Names and times only: coordinates are never exported. */
export interface PlacesExport {
  note: string;
  /** a stay in progress, if any */
  now: { place: string; since: string; minutes: number } | null;
  totals: { place: string; minutes: number; visits: number }[];
  visits: { place: string; start: string; end: string; minutes: number }[];
}

/** Meals logged in this app (calories estimated by AI from photos or web search). */
export interface FoodExport {
  note: string;
  byDay: { date: string; kcal: number; protein: number; carbs: number; fat: number }[];
  meals: { at: string; name: string; kcal: number; protein: number; carbs: number; fat: number; source: string }[];
}

/** Everything the app read, in the shape that is copied out as JSON. */
export interface ExportData {
  source: string;
  generatedAt: string;
  rangeDays: number;
  metrics: MetricResult[];
  sleep: SleepSession[];
  workouts: Workout[];
  places?: PlacesExport;
  food?: FoodExport;
}
