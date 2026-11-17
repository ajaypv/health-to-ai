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

/** Everything the app read, in the shape that is copied out as JSON. */
export interface ExportData {
  source: string;
  generatedAt: string;
  rangeDays: number;
  metrics: MetricResult[];
  sleep: SleepSession[];
  workouts: Workout[];
}
