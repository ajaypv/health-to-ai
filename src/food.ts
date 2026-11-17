/** The food log: meals added in this app, kept on the phone. */
export interface FoodEntry {
  id: string;
  at: number;
  name: string;
  kcal: number;
  protein: number;
  carbs: number;
  fat: number;
  source: 'photo' | 'search';
  confidence?: string;
}

const KEY = 'h2ai.food.v1';
let entries: FoodEntry[] = [];
let persist = true;

export function loadFood() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) entries = JSON.parse(raw);
  } catch { entries = []; }
}
function saveFood() {
  if (!persist) return;
  try { localStorage.setItem(KEY, JSON.stringify(entries)); } catch { /* storage full or blocked */ }
}

export const foodEntries = () => entries;

export function addFood(e: Omit<FoodEntry, 'id'>) {
  entries.push({ ...e, id: `${e.at}-${Math.random().toString(36).slice(2, 7)}` });
  entries.sort((a, b) => a.at - b.at);
  saveFood();
}

export function removeFood(id: string) {
  entries = entries.filter((e) => e.id !== id);
  saveFood();
}

export const inRange = (from: number, to: number) => entries.filter((e) => e.at >= from && e.at <= to);

const sum = (list: FoodEntry[], k: 'kcal' | 'protein' | 'carbs' | 'fat') => list.reduce((a, e) => a + e[k], 0);
export const totalsOf = (list: FoodEntry[]) => ({ kcal: sum(list, 'kcal'), protein: sum(list, 'protein'), carbs: sum(list, 'carbs'), fat: sum(list, 'fat') });

export function seedDemoFood() {
  persist = false;
  const H = 3_600_000;
  const day = new Date();
  day.setHours(0, 0, 0, 0);
  const t = (d: number, h: number) => day.getTime() - d * 24 * H + h * H;
  const meals: [number, number, string, number, number, number, number, 'photo' | 'search'][] = [
    [0, 8.5, 'Oats with banana', 340, 11, 62, 6, 'photo'],
    [0, 13, 'Chicken biryani', 640, 37, 75, 21, 'photo'],
    [1, 8.2, 'Two dosa with sambar', 410, 10, 72, 9, 'search'],
    [1, 13.1, 'Paneer wrap', 520, 22, 52, 24, 'photo'],
    [1, 20, 'Dal rice', 560, 20, 90, 12, 'photo'],
    [2, 9, 'Idli (3) with chutney', 290, 9, 55, 4, 'search'],
    [2, 19.5, 'Veg pizza (2 slices)', 560, 22, 66, 22, 'photo'],
  ];
  entries = meals
    .map(([d, h, name, kcal, protein, carbs, fat, source], i) => ({ id: `demo${i}`, at: t(d, h), name, kcal, protein, carbs, fat, source, confidence: 'medium' }))
    .filter((e) => e.at <= Date.now());
}
