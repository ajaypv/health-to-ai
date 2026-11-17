/**
 * Calories from Google Gemini: from a photo of food, or from a web search ("grounded" in Google Search).
 * The API key is the user's own, saved only in this phone's local storage. Photos and text go to Google.
 */
const BASE = 'https://generativelanguage.googleapis.com/v1beta';
/** Newest first. The first one the key can use is picked; "Model" in the food settings overrides it. */
const PREFERRED = [
  'gemini-4-hydrogen', 'gemini-4-argon', 'gemini-3.8-flash', 'gemini-3.6-flash',
  'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-2.5-flash-lite', 'gemini-2.5-flash',
];

const KEY_KEY = 'h2ai.gemini.key';
const MODEL_KEY = 'h2ai.gemini.model';
const read = (k: string) => { try { return localStorage.getItem(k) ?? ''; } catch { return ''; } };
const write = (k: string, v: string) => { try { if (v) localStorage.setItem(k, v); else localStorage.removeItem(k); } catch { /* blocked */ } };

export const apiKey = { get: () => read(KEY_KEY), set: (v: string) => write(KEY_KEY, v.trim()), clear: () => { write(KEY_KEY, ''); write(MODEL_KEY, ''); } };
export const modelOverride = { get: () => read(MODEL_KEY), set: (v: string) => write(MODEL_KEY, v.trim()) };

export interface FoodItem { name: string; portion: string; calories: number; protein: number; carbs: number; fat: number }
export interface FoodEstimate {
  name: string;
  items: FoodItem[];
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
  confidence: string;
  notes: string;
  sources: { title: string; uri: string }[];
}

const SHAPE =
  'Reply with ONLY a JSON object, no markdown and no extra words, with these keys: ' +
  'name (short meal name), items (array of {name, portion, calories, protein_g, carbs_g, fat_g}), ' +
  'calories (total kcal), protein_g, carbs_g, fat_g (totals for the whole meal), ' +
  'confidence ("low", "medium" or "high") and notes (one short sentence, mention any guessed portion size). ' +
  'Numbers only, no units.';

const PHOTO_PROMPT = (note: string) =>
  'You are a careful nutrition assistant. Identify the food in this photo and estimate its calories and macros for the portion shown. ' +
  'Judge portion size from the plate, bowl or packaging; if unsure, assume a typical single serving. ' +
  (note ? `The user says: "${note}". ` : '') + SHAPE;

const SEARCH_PROMPT = (query: string) =>
  `You are a careful nutrition assistant. Search the web for reliable calorie and nutrition data (nutrition labels, official brand or restaurant pages, USDA) for: "${query}". ` +
  'Use the figures you find for the quantity the user gave, or a typical single serving if none was given. ' + SHAPE;

type Part = { text: string } | { inlineData: { mimeType: string; data: string } };

async function http(path: string, key: string, body?: unknown, extra: Record<string, string> = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'x-goog-api-key': key, ...(body ? { 'Content-Type': 'application/json' } : {}), ...extra },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  if (!res.ok) {
    const msg: string = json?.error?.message ?? text.slice(0, 200);
    if (res.status === 429) throw new GeminiError('Free limit reached. Wait a minute, or try again tomorrow.', 429);
    if (res.status === 400 && /api key/i.test(msg)) throw new GeminiError('That API key was not accepted. Check it and try again.', 400);
    if (res.status === 403) throw new GeminiError('This key is not allowed to use Gemini. Create a new key at aistudio.google.com/apikey.', 403);
    throw new GeminiError(msg || `Request failed (${res.status})`, res.status);
  }
  return json;
}

export class GeminiError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

/** Pick a model this key can use: the newest from PREFERRED, else the newest plain "flash" model. */
async function pickModel(key: string): Promise<string> {
  const chosen = modelOverride.get();
  if (chosen) return chosen;
  const json = await http('/models?pageSize=200', key);
  const names: string[] = (json?.models ?? [])
    .filter((m: any) => (m.supportedGenerationMethods ?? []).includes('generateContent'))
    .map((m: any) => String(m.name).replace(/^models\//, ''));
  const hit = PREFERRED.find((p) => names.includes(p));
  if (hit) return hit;
  const flash = names
    .filter((n) => /^gemini-[\d.]+-flash(-lite)?$/.test(n))
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  if (flash[0]) return flash[0];
  throw new GeminiError('No Gemini model is available for this key.', 404);
}

async function generate(key: string, parts: Part[], search: boolean) {
  const model = await pickModel(key);
  const body: Record<string, unknown> = {
    contents: [{ role: 'user', parts }],
    generationConfig: { temperature: 0.2, ...(search ? {} : { responseMimeType: 'application/json' }) },
    ...(search ? { tools: [{ google_search: {} }] } : {}),
  };
  try {
    const json = await http(`/models/${model}:generateContent`, key, body);
    const cand = json?.candidates?.[0];
    const text: string = (cand?.content?.parts ?? []).map((p: any) => p.text ?? '').join('');
    const sources = (cand?.groundingMetadata?.groundingChunks ?? [])
      .map((c: any) => c.web)
      .filter((w: any) => w?.uri)
      .map((w: any) => ({ title: String(w.title ?? w.uri), uri: String(w.uri) }));
    if (!text) throw new GeminiError('Gemini returned no answer. Try again with a clearer photo or description.', 0);
    return { text, sources };
  } catch (e) {
    // Newer Gemini versions document the "interactions" endpoint. Use it if generateContent is gone.
    if (!(e instanceof GeminiError) || e.status !== 404) throw e;
    const input = parts.map((p) => ('text' in p ? { type: 'text', text: p.text } : { type: 'image', data: p.inlineData.data, mime_type: p.inlineData.mimeType }));
    const json = await http('/interactions', key, { model, input, ...(search ? { tools: [{ type: 'google_search' }] } : {}) }, { 'Api-Revision': '2026-05-20' });
    const text: string = json?.output_text ?? (json?.outputs ?? []).map((o: any) => o.text ?? '').join('');
    if (!text) throw new GeminiError('Gemini returned no answer.', 0);
    return { text, sources: [] as { title: string; uri: string }[] };
  }
}

const n = (v: unknown) => {
  const x = typeof v === 'string' ? parseFloat(v) : (v as number);
  return Number.isFinite(x) ? Math.max(0, Math.round(x * 10) / 10) : 0;
};

export function parseEstimate(text: string, sources: { title: string; uri: string }[]): FoodEstimate {
  const a = text.indexOf('{');
  const b = text.lastIndexOf('}');
  if (a < 0 || b <= a) throw new GeminiError('Could not read the answer. Try again.', 0);
  let o: any;
  try { o = JSON.parse(text.slice(a, b + 1)); } catch { throw new GeminiError('Could not read the answer. Try again.', 0); }
  const items: FoodItem[] = (Array.isArray(o.items) ? o.items : []).map((i: any) => ({
    name: String(i.name ?? 'Item'), portion: String(i.portion ?? ''), calories: n(i.calories), protein: n(i.protein_g), carbs: n(i.carbs_g), fat: n(i.fat_g),
  }));
  const sum = (k: keyof FoodItem) => items.reduce((acc, i) => acc + (i[k] as number), 0);
  const calories = n(o.calories) || sum('calories');
  if (!calories) throw new GeminiError('No calories found. Try a clearer photo or a more specific description.', 0);
  return {
    name: String(o.name ?? items[0]?.name ?? 'Meal').slice(0, 80),
    items,
    calories,
    protein: n(o.protein_g) || sum('protein'),
    carbs: n(o.carbs_g) || sum('carbs'),
    fat: n(o.fat_g) || sum('fat'),
    confidence: ['low', 'medium', 'high'].includes(String(o.confidence)) ? String(o.confidence) : 'medium',
    notes: String(o.notes ?? '').slice(0, 200),
    sources,
  };
}

export async function estimateFromPhoto(key: string, base64: string, note: string): Promise<FoodEstimate> {
  const { text, sources } = await generate(key, [{ text: PHOTO_PROMPT(note) }, { inlineData: { mimeType: 'image/jpeg', data: base64 } }], false);
  return parseEstimate(text, sources);
}

export async function estimateFromSearch(key: string, query: string): Promise<FoodEstimate> {
  const { text, sources } = await generate(key, [{ text: SEARCH_PROMPT(query) }], true);
  return parseEstimate(text, sources);
}

/** Shrink a photo before upload: phones take 4000 px pictures, Gemini needs about 1000. */
export async function photoToJpeg(file: File, maxSide = 1024): Promise<{ base64: string; dataUrl: string }> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((ok, bad) => {
      const i = new Image();
      i.onload = () => ok(i);
      i.onerror = () => bad(new Error('Could not open that photo. Try a JPEG or PNG.'));
      i.src = url;
    });
    const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * scale);
    c.height = Math.round(img.naturalHeight * scale);
    c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
    const dataUrl = c.toDataURL('image/jpeg', 0.82);
    return { base64: dataUrl.slice(dataUrl.indexOf(',') + 1), dataUrl };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Canned answer so the screen can be previewed on a computer with ?demo. */
export async function demoEstimate(search: boolean, text: string): Promise<FoodEstimate> {
  await new Promise((r) => setTimeout(r, 900));
  return {
    name: text.trim() ? text.trim().slice(0, 40) : 'Chicken biryani',
    items: [
      { name: 'Basmati rice', portion: '1.5 cups', calories: 310, protein: 6, carbs: 68, fat: 2 },
      { name: 'Chicken pieces', portion: '3 pieces', calories: 270, protein: 28, carbs: 2, fat: 16 },
      { name: 'Raita', portion: '1/2 cup', calories: 60, protein: 3, carbs: 5, fat: 3 },
    ],
    calories: 640, protein: 37, carbs: 75, fat: 21, confidence: 'medium',
    notes: 'Portion guessed as one restaurant serving.',
    sources: search ? [{ title: 'Example nutrition source', uri: 'https://example.com' }] : [],
  };
}
