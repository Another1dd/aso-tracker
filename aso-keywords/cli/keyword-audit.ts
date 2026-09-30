#!/usr/bin/env tsx
// Keyword field audit for any app. A plain HTTP client of a running studio (ranks and Apple Ads
// popularity live there), so it can run on a laptop while the data sits on the always-on Mac.
//
//   npm run keyword-audit -w aso-tracker-oss -- --app=flare-hot-flash-tracker \
//     --metadata=/path/to/ios/fastlane/metadata --base=http://192.168.31.119:5173
//
// Writes one markdown file per storefront to --out (default ~/.aso-studio/keywords/audits/<app>/<date>).
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { storefrontOf } from '../server/storefronts.js';

const LIMITS = { name: 30, subtitle: 30, keywords: 100 } as const;
type Field = keyof typeof LIMITS;
type LocaleMetadata = Record<Field, string>;
interface Row { keyword: string; current: number | null; popularity: number | null; popularityLabel: string; difficulty: number | null; chance: number | null; serpDepth: number | null }
interface Placement { locale: string; field: Field }

function args() {
  const values: Record<string, string> = {};
  for (const arg of process.argv.slice(2)) {
    const match = arg.match(/^--([^=]+)=(.*)$/);
    if (match) values[match[1]] = match[2];
  }
  return values;
}

const normalize = (value: string) => value.normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, ' ').trim();
const wordsOf = (value: string) => Array.from(normalize(value).matchAll(/[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*/gu), (match) => match[0]);
const stem = (word: string) => word.replace(/(es|s)$/u, '');

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status} ${url}`);
  return response.json() as Promise<T>;
}

async function readMetadata(dir: string): Promise<Record<string, LocaleMetadata>> {
  const out: Record<string, LocaleMetadata> = {};
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const read = (file: string) => readFile(join(dir, entry.name, file), 'utf8').then((text) => text.replace(/\n$/, ''), () => '');
    const [name, subtitle, keywords] = await Promise.all([read('name.txt'), read('subtitle.txt'), read('keywords.txt')]);
    if (name || subtitle || keywords) out[entry.name] = { name, subtitle, keywords };
  }
  return out;
}

/** Apple Ads popularity is one global value per string; fetch each distinct term once. */
async function popularityOf(base: string, appId: number, terms: string[]): Promise<Map<string, number | null>> {
  const values = new Map<string, number | null>();
  const deadline = Date.now() + 8 * 60_000;
  while (Date.now() < deadline) {
    const response = await fetch(`${base}/asa-api/keyword-popularity`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: appId, country: 'us', terms, wait_ms: 60_000 }),
    });
    if (!response.ok) throw new Error(`popularity ${response.status}`);
    const data = await response.json() as { items: Array<{ term: string; popularity: number | null }>; pending: number };
    for (const item of data.items) values.set(item.term, item.popularity);
    if (data.pending === 0) return values;
  }
  throw new Error('popularity did not finish in time');
}

interface DemandItem { term: string; popularity: number | null; band: string; confidence: string; note: string; depth: { status: string; chars?: number } }

/** Popularity plus autocomplete depth for terms; the server queues the probes, so poll until nothing is pending. */
async function demandFor(base: string, appId: string, storefront: string, terms: string[]): Promise<Map<string, DemandItem>> {
  const out = new Map<string, DemandItem>();
  const deadline = Date.now() + 25 * 60_000;
  while (terms.length && Date.now() < deadline) {
    const response = await fetch(`${base}/api/apps/${appId}/demand`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ storefront, terms, wait_ms: 45_000 }),
    });
    if (!response.ok) throw new Error(`demand ${response.status}`);
    const data = await response.json() as { items: DemandItem[]; pending: number };
    for (const item of data.items) out.set(item.term, item);
    if (data.pending === 0) break;
  }
  return out;
}

const BAND_ORDER = ['A', 'B', 'C', 'D', 'unknown'];
const bandText = (item: DemandItem | undefined) => (item ? `${item.band}${item.depth.status === 'hit' ? ` (${item.depth.chars} симв.${(item.depth as { match?: string }).match === 'extended' ? ', продолжение' : ''})` : ''}` : '—');

const popLabel = (value: number | null | undefined) => (value == null ? 'нет данных' : value <= 5 ? '≤5' : String(value));

function fieldLine(field: Field, text: string) {
  const length = Array.from(text).length;
  return `${field === 'name' ? 'Название' : field === 'subtitle' ? 'Подзаголовок' : 'Ключи'}: «${text}» (${length}/${LIMITS[field]}${length > LIMITS[field] ? ', ПРЕВЫШЕН' : ''})`;
}

async function main() {
  const options = args();
  const appId = options.app;
  if (!appId || !options.metadata) throw new Error('usage: --app=<tool app id> --metadata=<fastlane metadata dir> [--base=http://localhost:5173] [--out=dir] [--demand=us,de|none]');
  const base = (options.base ?? 'http://localhost:5173').replace(/\/$/, '');
  const date = new Date().toISOString().slice(0, 10);
  const outDir = resolve(options.out ?? join(homedir(), '.aso-studio', 'keywords', 'audits', appId, date));

  const apps = await getJson<Array<{ id: string; name: string; iTunesId: string; locales?: string[] }>>(`${base}/api/apps`);
  const app = apps.find((item) => item.id === appId);
  if (!app) throw new Error(`unknown app ${appId}`);
  const metadata = await readMetadata(resolve(options.metadata));
  const storefronts = app.locales ?? [];
  const demandStorefronts = new Set((options.demand ?? 'us').split(',').filter((code) => code && code !== 'none'));

  const tables = new Map<string, Row[]>();
  for (const code of storefronts) {
    const table = await getJson<{ rows: Row[] }>(`${base}/api/apps/${appId}/keyword-table?storefront=${code}`);
    tables.set(code, table.rows);
  }

  const tokenSet = new Set<string>();
  for (const value of Object.values(metadata)) for (const field of Object.keys(LIMITS) as Field[]) wordsOf(value[field]).forEach((word) => tokenSet.add(word));
  for (const rows of tables.values()) rows.forEach((row) => row.popularity != null && tokenSet.add(normalize(row.keyword)));
  const popularity = await popularityOf(base, Number(app.iTunesId), [...tokenSet].sort());

  await mkdir(outDir, { recursive: true });
  for (const code of storefronts) {
    const storefront = storefrontOf(code);
    const indexed = storefront.locales.filter((locale) => metadata[locale]);
    const lines: string[] = [];
    lines.push(`# Аудит поля ключей: ${app.name}, ${storefront.name} (${code.toUpperCase()})`, '', `Дата: ${date}. Данные ранга и популярности: ${base}.`, '');
    lines.push('Популярность Apple Ads (5–100) — факт, но Apple отдаёт одно значение на строку для всех витрин, «≤5» означает «ниже порога Apple», а не «никто не ищет». Список индексируемых локалей взят из таблицы Apple (storefronts.ts), не проверен по факту.', '');
    lines.push('Популярность отдельного слова включает все его значения («flush», «diary», «sleep» ищут и вне темы приложения), поэтому у одиночных слов число не читается как спрос ниши. Пустое значение — Apple не вернул строку.', '');
    lines.push(`## Индексируемые локали, найденные в metadata: ${indexed.length ? indexed.join(', ') : 'нет'}`, '');
    if (!indexed.length) { await writeFile(join(outDir, `${code}.md`), lines.join('\n') + '\n'); continue; }
    for (const locale of indexed) {
      lines.push(`**${locale}**`);
      for (const field of Object.keys(LIMITS) as Field[]) lines.push(`- ${fieldLine(field, metadata[locale][field])}`);
      lines.push('');
    }

    const seen = new Map<string, Placement[]>();
    const remember = (word: string, placement: Placement) => seen.set(word, [...(seen.get(word) ?? []), placement]);
    for (const locale of indexed) for (const field of Object.keys(LIMITS) as Field[]) wordsOf(metadata[locale][field]).forEach((word) => remember(word, { locale, field }));
    const visible = new Set<string>();
    for (const [word, places] of seen) if (places.some((place) => place.field !== 'keywords')) visible.add(word);

    lines.push('## Слова поля ключей', '', '| Слово | Популярность Apple | Символов | Замечание |', '|---|---|---|---|');
    let wasted = 0;
    let unused = 0;
    for (const locale of indexed) {
      const raw = metadata[locale].keywords;
      const entries = raw.split(',');
      unused += LIMITS.keywords - Array.from(raw).length;
      const seenHere = new Set<string>();
      for (const entry of entries) {
        const trimmed = entry.trim();
        if (!trimmed) continue;
        const notes: string[] = [];
        if (entry !== trimmed) notes.push('пробел рядом с запятой тратит символ');
        const words = wordsOf(trimmed);
        const key = words.join(' ');
        if (seenHere.has(key)) notes.push('повтор в этом же поле');
        seenHere.add(key);
        const inVisible = words.filter((word) => visible.has(word));
        if (inVisible.length === words.length) notes.push('уже есть в названии или подзаголовке, слот потрачен зря');
        else if (inVisible.length) notes.push(`«${inVisible.join(' ')}» уже в названии или подзаголовке`);
        const twins = words.filter((word) => [...seen.keys()].some((other) => other !== word && stem(other) === stem(word) && stem(word).length > 2));
        if (twins.length) notes.push(`форма единственного/множественного числа уже встречается: ${twins.join(', ')} (Apple обычно склеивает формы, проверьте)`);
        if (inVisible.length === words.length) wasted += Array.from(trimmed).length + 1;
        lines.push(`| ${locale}: ${trimmed} | ${popLabel(popularity.get(normalize(trimmed)))} | ${Array.from(trimmed).length} | ${notes.join('; ') || '—'} |`);
      }
    }
    lines.push('', `Символов в полях ключей потрачено на слова, которые уже есть в видимых полях: ${wasted}. Не заполнено: ${unused}.`, '');

    const rows = tables.get(code) ?? [];
    const covered = (keyword: string) => wordsOf(keyword).filter((word) => !seen.has(word) && ![...seen.keys()].some((other) => stem(other) === stem(word)));
    const demand = demandStorefronts.has(code) ? await demandFor(base, appId, code, rows.map((row) => normalize(row.keyword))) : new Map<string, DemandItem>();
    lines.push('## Отслеживаемые ключи', '', 'Группа спроса: A — значение Apple выше 5 (факт); B, C, D — значение на границе, фраза предлагается в подсказках рано, поздно или никогда (оценка по автоподсказкам, не объём поиска; порог групп предварительный, до проверки).', '');
    lines.push('| Ключ | Наш ранг | Популярность Apple | Группа спроса | Сложность | Шанс | Слов нет в metadata | Уверенность |', '|---|---|---|---|---|---|---|---|');
    const sorted = [...rows].sort((a, b) => (b.popularity ?? 0) - (a.popularity ?? 0) || (a.current || 9999) - (b.current || 9999));
    for (const row of sorted) {
      const missing = covered(row.keyword);
      const confidence = row.popularity != null && row.popularity > 5 ? 'высокая (факт)' : row.popularity == null ? 'нет данных' : 'спрос неизвестен: значение на границе';
      lines.push(`| ${row.keyword} | ${row.current ? `#${row.current}` : 'нет в топе'} | ${row.popularityLabel ?? popLabel(row.popularity)} | ${demandStorefronts.has(code) ? bandText(demand.get(normalize(row.keyword))) : 'не считалась'} | ${row.difficulty ?? '—'} | ${row.chance ?? '—'} | ${missing.join(', ') || '—'} | ${confidence} |`);
    }
    lines.push('', 'Ранг «нет в топе» означает «не найдено в глубине последней проверки», не «не ранжируется». Сложность и шанс пусты, пока не прошёл разбор выдачи.', '');

    if (demandStorefronts.has(code)) {
      const ideas = await getJson<{ ideas: Array<{ keyword: string; score: number }> }>(`${base}/api/apps/${appId}/suggestions?locale=${code}`);
      const tracked = new Set(rows.map((row) => normalize(row.keyword)));
      const options = ideas.ideas
        .filter((idea) => !tracked.has(normalize(idea.keyword)))
        .map((idea) => ({ keyword: normalize(idea.keyword), missing: covered(idea.keyword), score: idea.score }))
        .filter((idea) => idea.missing.length <= 1)
        .slice(0, 30);
      const bands = await demandFor(base, appId, code, options.map((idea) => idea.keyword));
      const ranked = options
        .map((idea) => ({ ...idea, band: bands.get(idea.keyword), chars: idea.missing.length ? Array.from(idea.missing[0]).length + 1 : 0 }))
        .sort((a, b) => BAND_ORDER.indexOf(a.band?.band ?? 'unknown') - BAND_ORDER.indexOf(b.band?.band ?? 'unknown') || a.chars - b.chars || b.score - a.score);
      lines.push('## Кандидаты на замену', '', 'Фразы из генератора идей (с отбором по опорным словам), для которых в metadata не хватает не больше одного слова. Сортировка: группа спроса, затем сколько символов поля ключей нужно (слово плюс запятая). Это гипотезы для теста, не рекомендации.', '');
      lines.push('| Фраза | Группа спроса | Популярность Apple | Не хватает слова | Символов | Балл идеи |', '|---|---|---|---|---|---|');
      for (const idea of ranked) lines.push(`| ${idea.keyword} | ${bandText(idea.band)} | ${popLabel(idea.band?.popularity)} | ${idea.missing.join(', ') || '—'} | ${idea.chars} | ${idea.score} |`);
      lines.push('');
    }
    await writeFile(join(outDir, `${code}.md`), lines.join('\n') + '\n');
    console.log(`${code}: ${indexed.length} locale(s), ${rows.length} tracked keyword(s), ${wasted} wasted chars`);
  }
  console.log(`Wrote ${outDir}`);
}

main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exit(1); });
