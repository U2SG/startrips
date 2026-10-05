import { STARTRIPS_PULL_PHASES as P } from "../brand/startripsPullClip";
import { BOOK_FLIP_SECONDS } from "./journeyBook3dModel";

/**
 * The 3D Journey Book's brand moment: the v12 goat climbs out of the closed
 * front cover's emboss, walks to the fore-edge, tugs twice and heaves the
 * cover open, then hops off and fades. One-shot, skippable, never in the way
 * (docs/motion-language.md): it plays once per Journey per device after the
 * reader has left the closed cover alone for a moment, a tap on the mark plays
 * it again, any input takes over at once, and reduced motion never plays it.
 *
 * Pure timing and staging, in the clip's milliseconds. The goat's articulation
 * is the brand `pull` clip (`startripsPullClip.ts`); this file owns where it
 * stands on the cover and how far the cover lifts.
 */

/** The reader has left the closed cover alone this long. */
export const GOAT_PULL_IDLE_MS = 900;

/** Cover angles: quick_flipbook turns a sheet `progress · 180°`. */
const degrees = (value: number) => value / 180;
export const GOAT_PULL_COVER = {
  tug1: degrees(4),
  tug2: degrees(10),
  /** Tug 2 drops back less: the cover rests here when the heave begins. */
  tug2Rest: degrees(3),
  /** Past upright the cover is handed back to the book's own turn. */
  release: 0.55,
} as const;

/** Total time from the wake to the cover lying open (the book's own turn included). */
export const GOAT_PULL_TOTAL_MS = P.release + BOOK_FLIP_SECONDS * 1000;

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value));
}

function smoothstep(start: number, end: number, value: number) {
  const t = clamp01((value - start) / (end - start));
  return t * t * (3 - 2 * t);
}

/** Up from `from` to `peak` and back down to `to`, smoothly, between `start` and `end`. */
function tug(t: number, start: number, peakAt: number, end: number, from: number, peak: number, to: number) {
  if (t <= peakAt) return from + (peak - from) * smoothstep(start, peakAt, t);
  return peak + (to - peak) * smoothstep(peakAt, end, t);
}

/**
 * Cover progress `t` ms into the performance. The clip drives it until
 * `release`; after that the book's own turn finishes it at quick_flipbook's
 * constant rate, which this mirrors so a scrubbed frame shows what the live
 * turn shows. The heave leaves at the same rate, so the hand-back has no kink.
 */
export function goatPullCoverProgress(elapsedMs: number): number {
  const t = Number.isFinite(elapsedMs) ? elapsedMs : 0;
  const { tug1, tug2, tug2Rest, release } = GOAT_PULL_COVER;
  const releaseRate = (1 - release) / (BOOK_FLIP_SECONDS * 1000);
  if (t <= P.gripEnd) return 0;
  if (t <= P.tug1End) return tug(t, P.gripEnd, P.tug1Peak, P.tug1End, 0, tug1, 0);
  if (t <= P.tug2End) return tug(t, P.tug1End, P.tug2Peak, P.tug2End, 0, tug2, tug2Rest);
  if (t < P.release) {
    // Cubic Hermite from rest (no speed) to the release angle at the turn's rate.
    const span = P.release - P.tug2End;
    const s = (t - P.tug2End) / span;
    const endSlope = releaseRate * span;
    const h01 = -2 * s ** 3 + 3 * s ** 2;
    const h11 = s ** 3 - s ** 2;
    return tug2Rest + (release - tug2Rest) * h01 + endSlope * h11;
  }
  return Math.min(1, release + (t - P.release) * releaseRate);
}

/** The mark's frame on the cover, as fractions (`coverMarkFrame`). */
export type MarkFrame = { x: number; y: number; width: number; height: number };

/**
 * The goat's muzzle sits this far right of the mark's centre once mirrored to
 * face the fore-edge, as a fraction of the mark's width (v12 muzzle at x 657
 * in the 610–780 viewBox, centre 695).
 */
const MUZZLE_OFFSET = (695 - 657) / 170;
/** The goat's hooves stand this far above the foot of the mark's viewBox (18 of 150 units). */
export const GOAT_HOOF_RISE = 18 / 150;
/** The goat's horns reach this far above its hooves, as a fraction of the mark's height (at most the viewBox's 132 of 150 units). */
export const GOAT_REACH = 132 / 150;
/** Where the muzzle hooks the fore-edge, just inside it. */
const GRIP_U = 0.995;
/** The strip below the tipped-in plate where the goat walks: its hooves on this line, just inside the cover's foot. */
export const GOAT_WALK_V = 0.996;
/**
 * Once awake the goat grows to this width of the cover (its mark's frame,
 * the stamp being about 0.067 wide): large enough for its lean, braced legs
 * and head to read, small enough to walk below the plate.
 */
export const GOAT_AWAKE_WIDTH = 0.1;
/** The live goat at full presence: brand starlight, held back so the foil stays the one bright point. */
export const GOAT_OPACITY = 0.86;

/** How much larger than its stamp the goat grows while it wakes. */
export function goatAwakeScale(mark: MarkFrame): number {
  return Math.max(1, GOAT_AWAKE_WIDTH / mark.width);
}

export type GoatPullStaging = {
  /** Cover u (0 spine, 1 fore-edge) of the point between the goat's hooves. */
  u: number;
  /** Cover v of that point: on the emboss while waking, then the strip below the plate. */
  v: number;
  /** The goat's size relative to its stamp: 1 as stamped, `goatAwakeScale` once awake. */
  scale: number;
  /** Horizontal scale: 1 faces left as stamped, −1 faces the fore-edge; between, it is turning. */
  facing: number;
  /** 0 the stamped tone, 1 starlight. */
  tone: number;
  opacity: number;
  /** 0 on the cover, 1 landed on the table past the fore-edge. */
  hop: number;
  /** Height of the hop's arc, in mark heights. */
  hopLift: number;
};

export function goatPullStaging(elapsedMs: number, mark: MarkFrame): GoatPullStaging {
  const t = Math.max(0, Math.min(P.end, Number.isFinite(elapsedMs) ? elapsedMs : 0));
  const awake = goatAwakeScale(mark);
  const startU = mark.x + mark.width / 2;
  const startV = mark.y + mark.height * (1 - GOAT_HOOF_RISE);
  const gripU = GRIP_U - MUZZLE_OFFSET * mark.width * awake;
  const walkStart = P.wakeEnd + 120;
  const turn = smoothstep(P.wakeEnd, P.wakeEnd + 160, t);
  const walk = smoothstep(walkStart, P.walkEnd, t);
  // It steps down off the stamp's line into the strip below the plate early
  // in the walk, well before it reaches the plate.
  const descend = smoothstep(walkStart, walkStart + (P.walkEnd - walkStart) * 0.35, t);
  const tone = smoothstep(0, P.wakeEnd, t);
  const hopRaw = clamp01((t - P.letGo) / (P.release - P.letGo));
  const fade = 1 - smoothstep(P.release, P.end, t);
  return {
    u: startU + (gripU - startU) * walk,
    v: startV + (GOAT_WALK_V - startV) * descend,
    scale: 1 + (awake - 1) * tone,
    facing: Math.cos(Math.PI * turn),
    tone,
    opacity: (1 - (1 - GOAT_OPACITY) * tone) * fade,
    hop: smoothstep(0, 1, hopRaw),
    hopLift: 0.6 * Math.sin(Math.PI * hopRaw),
  };
}

/** What the book knows when deciding whether the goat may wake on its own. */
export type GoatPullAutoState = {
  reduced: boolean;
  played: boolean;
  /** The reader is on the closed front cover, at rest. */
  onClosedCover: boolean;
  /** The cover's mark is painted, so the goat has an emboss to leave. */
  markReady: boolean;
  /** Anything over the book (contents, a full note, a failure) or a scrubbing harness. */
  blocked: boolean;
};

export function goatPullAutoEligible(state: GoatPullAutoState): boolean {
  return !state.reduced && !state.played && state.onClosedCover && state.markReady && !state.blocked;
}

/** A tap on the mark replays it; the hit area is at least `minHit` px square around the mark. */
export function goatPullMarkHit(
  point: { x: number; y: number },
  mark: { left: number; top: number; width: number; height: number },
  minHit = 44,
): boolean {
  const width = Math.max(mark.width, minHit);
  const height = Math.max(mark.height, minHit);
  const centreX = mark.left + mark.width / 2;
  const centreY = mark.top + mark.height / 2;
  return Math.abs(point.x - centreX) <= width / 2 && Math.abs(point.y - centreY) <= height / 2;
}

/** localStorage key: the Journeys whose goat has played on this device. */
export const GOAT_PULL_PLAYED_KEY = "startrips.journeyBook3d.goatPull.played";
const PLAYED_LIMIT = 200;
/** Played this session when storage cannot say: never plays twice, never loops. */
const playedThisSession = new Set<string>();

type PlayedStorage = Pick<Storage, "getItem" | "setItem">;

function readPlayed(storage: PlayedStorage | null): string[] {
  try {
    const raw = storage?.getItem(GOAT_PULL_PLAYED_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

export function goatPullPlayed(storage: PlayedStorage | null, journeyId: string): boolean {
  return playedThisSession.has(journeyId) || readPlayed(storage).includes(journeyId);
}

/** Record that the goat played for a Journey; storage failures fall back to this session. */
export function markGoatPullPlayed(storage: PlayedStorage | null, journeyId: string): void {
  playedThisSession.add(journeyId);
  try {
    const list = readPlayed(storage).filter((entry) => entry !== journeyId);
    list.push(journeyId);
    storage?.setItem(GOAT_PULL_PLAYED_KEY, JSON.stringify(list.slice(-PLAYED_LIMIT)));
  } catch {
    // Storage is full or refused; this session still remembers.
  }
}

/** The device's localStorage, or null where reading it throws. */
export function goatPullStorage(): PlayedStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}
