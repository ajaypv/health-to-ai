import type { HealthDataType } from '@capgo/capacitor-health';

/**
 * How a metric is read and summarised:
 * - sum:    a running total per day (steps, distance...). Today's total is the headline.
 * - stat:   frequent readings (heart rate...). Latest reading is the headline, plus avg/min/max.
 * - latest: rare readings (weight, blood pressure...). Latest reading is the headline.
 */
export type Kind = 'sum' | 'stat' | 'latest';

export interface Metric {
  id: HealthDataType;
  label: string;
  group: 'Activity' | 'Heart & stress' | 'Body' | 'Nutrition';
  kind: Kind;
  /** The plugin can aggregate this on Android (sum, or avg/min/max), which is faster and exact. */
  aggregated?: boolean;
  format: (v: number) => string;
}

const n0 = (v: number) => Math.round(v).toLocaleString();
const n1 = (v: number) => (Math.round(v * 10) / 10).toLocaleString();
const n2 = (v: number) => (Math.round(v * 100) / 100).toLocaleString();
const unit = (u: string, f: (v: number) => string = n0) => (v: number) => `${f(v)} ${u}`;
export const fmtMinutes = (min: number) => `${Math.floor(min / 60)}h ${Math.round(min % 60)}m`;
export const fmtDistance = (m: number) => (m >= 1000 ? `${n2(m / 1000)} km` : `${n0(m)} m`);

export const METRICS: Metric[] = [
  { id: 'steps', label: 'Steps', group: 'Activity', kind: 'sum', aggregated: true, format: n0 },
  { id: 'distance', label: 'Walking distance', group: 'Activity', kind: 'sum', aggregated: true, format: fmtDistance },
  { id: 'distanceCycling', label: 'Cycling distance', group: 'Activity', kind: 'sum', format: fmtDistance },
  { id: 'flightsClimbed', label: 'Floors climbed', group: 'Activity', kind: 'sum', format: n0 },
  { id: 'calories', label: 'Active calories', group: 'Activity', kind: 'sum', aggregated: true, format: unit('kcal') },
  { id: 'totalCalories', label: 'Total calories', group: 'Activity', kind: 'sum', format: unit('kcal') },
  { id: 'mindfulness', label: 'Mindfulness', group: 'Activity', kind: 'sum', format: fmtMinutes },

  { id: 'heartRate', label: 'Heart rate', group: 'Heart & stress', kind: 'stat', aggregated: true, format: unit('bpm') },
  { id: 'restingHeartRate', label: 'Resting heart rate', group: 'Heart & stress', kind: 'stat', aggregated: true, format: unit('bpm') },
  { id: 'heartRateVariability', label: 'HRV (RMSSD)', group: 'Heart & stress', kind: 'stat', format: unit('ms') },
  { id: 'oxygenSaturation', label: 'Blood oxygen', group: 'Heart & stress', kind: 'stat', format: unit('%', n1) },
  { id: 'respiratoryRate', label: 'Breathing rate', group: 'Heart & stress', kind: 'stat', format: unit('/min', n1) },
  { id: 'vo2Max', label: 'VO2 max', group: 'Heart & stress', kind: 'latest', format: unit('ml/kg/min', n1) },
  { id: 'bloodPressure', label: 'Blood pressure', group: 'Heart & stress', kind: 'latest', format: unit('mmHg') },

  { id: 'weight', label: 'Weight', group: 'Body', kind: 'latest', aggregated: true, format: unit('kg', n1) },
  { id: 'height', label: 'Height', group: 'Body', kind: 'latest', format: unit('cm') },
  { id: 'bodyFat', label: 'Body fat', group: 'Body', kind: 'latest', format: unit('%', n1) },
  { id: 'bodyTemperature', label: 'Body temperature', group: 'Body', kind: 'latest', format: unit('°C', n1) },
  { id: 'basalBodyTemperature', label: 'Basal temperature', group: 'Body', kind: 'latest', format: unit('°C', n1) },
  { id: 'basalCalories', label: 'Basal metabolic rate', group: 'Body', kind: 'latest', format: unit('kcal/day') },
  { id: 'bloodGlucose', label: 'Blood glucose', group: 'Body', kind: 'latest', format: unit('mg/dL') },

  { id: 'dietaryEnergyConsumed', label: 'Calories eaten', group: 'Nutrition', kind: 'sum', aggregated: true, format: unit('kcal') },
  { id: 'dietaryProtein', label: 'Protein', group: 'Nutrition', kind: 'sum', aggregated: true, format: unit('g') },
  { id: 'dietaryWater', label: 'Water', group: 'Nutrition', kind: 'sum', aggregated: true, format: unit('L', n2) },
];

export const GROUPS = ['Activity', 'Heart & stress', 'Body', 'Nutrition'] as const;
