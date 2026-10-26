/** The source text is immutable: model output can annotate indices, never replace words. */
export type Passage = { text: string; speaker: string; voice: string; tone: string };
export type BookPage = { page: number; total: number; signature: string; passages: Passage[]; notice?: string; legacyIndices?: number[] };
export type Bookmark = { version: 1; page: number; passage: number; seconds: number; signature: string; speed: number; dramatic: boolean; savedAt: number; segmentation?: 2 };
export const BOOK_VOICES = ['Cherry', 'Ethan', 'Serena', 'Ryan', 'Chelsie', 'Aiden', 'Bella', 'Kai'] as const;
const TONES = ['neutral', 'gentle', 'excited', 'sad', 'tense'] as const;

export const isSpeakable = (text: string) => /[\p{L}\p{N}]/u.test(text);

export function splitBookText(text: string): string[] {
  // Closing quotes belong to the sentence before them, including across line breaks.
  const pieces = text.match(/[^。！？.!?\n]+[。！？.!?]*[”’」』）》】"]*|[。！？.!?]+[”’」』）》】"]*|\n+/gu) || [];
  const result: string[] = [];
  let prefix = '';
  for (const piece of pieces) {
    if (!isSpeakable(piece)) {
      if (result.length) result[result.length - 1] += piece;
      else prefix += piece;
      continue;
    }
    const chars = Array.from(prefix + piece); prefix = '';
    for (let i = 0; i < chars.length;) {
      let end = Math.min(i + 240, chars.length);
      // Reserve a spoken character for a trailing punctuation tail at the limit.
      if (end < chars.length && !isSpeakable(chars.slice(end).join(''))) {
        while (end > i && !isSpeakable(chars.slice(end).join(''))) --end;
        if (end === i) end = Math.min(i + 240, chars.length);
      }
      const part = chars.slice(i, end).join(''); i = end;
      if (isSpeakable(part)) result.push(part);
      else if (result.length) result[result.length - 1] += part;
      else prefix += part;
    }
  }
  // A standalone quote on the next line can also push a full chunk over the limit.
  return result.flatMap((part) => {
    const chars = Array.from(part);
    if (chars.length <= 240) return [part];
    let cut = 240;
    while (cut > 0 && !isSpeakable(chars.slice(cut).join(''))) --cut;
    return cut > 0 ? [chars.slice(0, cut).join(''), chars.slice(cut).join('')] : [part];
  });
}

/** Map checkpoints written by the old splitter without replaying the whole page. */
export function legacyPassageIndices(text: string, passages: string[]): number[] {
  const old = text.match(/[^。！？.!?\n]+[。！？.!?]?|[。！？.!?]+|\n+/gu) || [];
  const legacy: string[] = [];
  for (const piece of old) {
    const chars = Array.from(piece);
    for (let i = 0; i < chars.length; i += 240) {
      const part = chars.slice(i, i + 240).join('');
      if (part.trim()) legacy.push(part);
      else if (legacy.length) legacy[legacy.length - 1] += part;
    }
  }
  let offset = 0;
  const ends = passages.map((part) => (offset += part.replace(/\s/gu, '').length));
  offset = 0;
  return legacy.map((part) => {
    const index = ends.findIndex((end) => offset < end);
    offset += part.replace(/\s/gu, '').length;
    return index < 0 ? Math.max(0, passages.length - 1) : index;
  });
}

export function annotatePassages(texts: string[], raw: unknown, previous: Record<string, string>) {
  const cast = { ...previous };
  const entries = Array.isArray(raw) ? raw : [];
  const seen = new Set<number>();
  const valid = entries.length === texts.length && entries.every((e) => {
    if (!e || !Number.isInteger(e.index) || e.index < 0 || e.index >= texts.length || seen.has(e.index)
      || typeof e.speaker !== 'string' || e.speaker.length > 40 || !TONES.includes(e.tone)) return false;
    seen.add(e.index); return true;
  });
  const passages = texts.map((text, index) => {
    const entry = valid ? entries.find((e) => e.index === index) : null;
    const speaker = entry?.speaker.trim() || '旁白';
    let voice = Object.hasOwn(cast, speaker) && BOOK_VOICES.includes(cast[speaker] as typeof BOOK_VOICES[number]) ? cast[speaker] : '';
    if (!voice) {
      const count = Object.keys(cast).length;
      voice = speaker === '旁白' ? BOOK_VOICES[0] : BOOK_VOICES[1 + (count % (BOOK_VOICES.length - 1))];
      Object.defineProperty(cast, speaker, { value: voice, enumerable: true, writable: true, configurable: true });
    }
    return { text, speaker, voice, tone: entry?.tone || 'neutral' };
  });
  return { passages, cast, valid };
}

export function restoreBookmark(raw: unknown, page: BookPage): Bookmark {
  const b = raw as Partial<Bookmark> | null;
  const matches = b?.version === 1 && b.signature === page.signature && b.page === page.page;
  const number = (n: unknown, fallback: number) => typeof n === 'number' && Number.isFinite(n) ? n : fallback;
  const oldIndex = Math.max(0, Math.trunc(number(b?.passage, 0)));
  const mapped = b?.segmentation !== 2 ? page.legacyIndices?.[oldIndex] : undefined;
  return {
    version: 1, segmentation: 2, page: page.page, signature: page.signature,
    passage: matches ? Math.max(0, Math.min(mapped ?? oldIndex, Math.max(0, page.passages.length - 1))) : 0,
    seconds: matches && mapped === undefined ? Math.max(0, number(b?.seconds, 0)) : 0,
    speed: Math.max(0.75, Math.min(2, number(b?.speed, 1))), dramatic: b?.dramatic !== false,
    savedAt: number(b?.savedAt, 0),
  };
}

export function toneRate(tone: string) { return tone === 'sad' || tone === 'gentle' ? 0.94 : tone === 'excited' ? 1.06 : 1; }
