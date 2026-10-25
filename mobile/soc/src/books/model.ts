/** The source text is immutable: model output can annotate indices, never replace words. */
export type Passage = { text: string; speaker: string; voice: string; tone: string };
export type BookPage = { page: number; total: number; signature: string; passages: Passage[]; notice?: string };
export type Bookmark = { version: 1; page: number; passage: number; seconds: number; signature: string; speed: number; dramatic: boolean; savedAt: number };
export const BOOK_VOICES = ['Cherry', 'Ethan', 'Serena', 'Ryan', 'Chelsie', 'Aiden', 'Bella', 'Kai'] as const;
const TONES = ['neutral', 'gentle', 'excited', 'sad', 'tense'] as const;

export function splitBookText(text: string): string[] {
  // Keep punctuation, Markdown and stage directions: those are part of the book.
  const pieces = text.match(/[^。！？.!?\n]+[。！？.!?]?|[。！？.!?]+|\n+/gu) || [];
  const result: string[] = [];
  for (const piece of pieces) {
    const chars = Array.from(piece);
    for (let i = 0; i < chars.length; i += 240) {
      const part = chars.slice(i, i + 240).join('');
      if (part.trim()) result.push(part);
      else if (result.length) result[result.length - 1] += part;
    }
  }
  return result;
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
  return {
    version: 1, page: page.page, signature: page.signature,
    passage: matches ? Math.max(0, Math.min(Math.trunc(number(b?.passage, 0)), Math.max(0, page.passages.length - 1))) : 0,
    seconds: matches ? Math.max(0, number(b?.seconds, 0)) : 0,
    speed: Math.max(0.75, Math.min(2, number(b?.speed, 1))), dramatic: b?.dramatic !== false,
    savedAt: number(b?.savedAt, 0),
  };
}

export function toneRate(tone: string) { return tone === 'sad' || tone === 'gentle' ? 0.94 : tone === 'excited' ? 1.06 : 1; }
