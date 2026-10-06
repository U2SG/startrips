import { STARTRIPS_V12_AUTHORED_TIMELINE, type StartripsV12Part } from "./startripsV12MotionSource";

export type StartripsSignatureClipName = "full" | "loading" | "recovery";

export type StartripsSignatureClipEvent = {
  id: string;
  part: StartripsV12Part;
  kind: "notice" | "step" | "climb" | "gaze" | "leap" | "settle";
  sourceStartMs: number;
  sourceEndMs: number;
  clipStartMs: number;
  clipEndMs: number;
};

export type StartripsSignatureClip = {
  name: StartripsSignatureClipName;
  durationMs: number;
  loop: boolean;
  events: readonly StartripsSignatureClipEvent[];
};

const allEvents = STARTRIPS_V12_AUTHORED_TIMELINE.events;

function event(id: (typeof allEvents)[number]["id"], clipStartMs: number, clipEndMs: number): StartripsSignatureClipEvent {
  const source = allEvents.find((entry) => entry.id === id);
  if (!source) throw new Error(`Unknown v12 authored event: ${id}`);
  return {
    id: source.id,
    part: source.part,
    kind: source.kind,
    sourceStartMs: source.startMs,
    sourceEndMs: source.endMs,
    clipStartMs,
    clipEndMs,
  };
}

const FULL_CLIP: StartripsSignatureClip = {
  name: "full",
  durationMs: STARTRIPS_V12_AUTHORED_TIMELINE.durationMs,
  loop: false,
  events: allEvents.map((source) => ({
    id: source.id,
    part: source.part,
    kind: source.kind,
    sourceStartMs: source.startMs,
    sourceEndMs: source.endMs,
    clipStartMs: source.startMs,
    clipEndMs: source.endMs,
  })),
};

/**
 * Product loading is intentionally REMAPPED, not uniformly accelerated. The
 * short clip keeps the semantic sequence notice -> forehoof support -> rear
 * transfer -> settle while skipping the long tease/follow/leap narrative.
 */
const LOADING_CLIP: StartripsSignatureClip = {
  name: "loading",
  durationMs: 3_600,
  loop: true,
  events: [
    event("notice-star", 0, 760),
    event("notice-head", 0, 760),
    event("notice-eye", 0, 760),
    event("front-near-climb", 760, 1_520),
    event("front-far-climb", 930, 1_700),
    event("hind-near-transfer", 1_720, 2_560),
    event("hind-far-transfer", 1_900, 2_730),
    event("fore-near-home", 2_820, 3_300),
    event("hind-far-home", 3_040, 3_520),
  ],
};


/**
 * Recovery is a warm, one-shot remap of the same approved v12 events. It is
 * deliberately not a uniform speed-up: the notice breathes, the four support
 * contacts stay staggered, then the mark settles and never loops.
 */
const RECOVERY_CLIP: StartripsSignatureClip = {
  name: "recovery",
  durationMs: 4_200,
  loop: false,
  events: [
    event("notice-star", 0, 920),
    event("notice-head", 0, 920),
    event("notice-eye", 0, 920),
    event("front-near-climb", 980, 1_720),
    event("front-far-climb", 1_190, 1_930),
    event("hind-near-transfer", 1_940, 2_850),
    event("hind-far-transfer", 2_180, 3_080),
    event("fore-near-home", 3_260, 3_790),
    event("hind-far-home", 3_520, 4_080),
  ],
};

export const STARTRIPS_SIGNATURE_CLIPS: Readonly<Record<StartripsSignatureClipName, StartripsSignatureClip>> = {
  full: FULL_CLIP,
  loading: LOADING_CLIP,
  recovery: RECOVERY_CLIP,
};

export function getStartripsSignatureClip(name: StartripsSignatureClipName) {
  return STARTRIPS_SIGNATURE_CLIPS[name];
}

export function isUniformTimelineScale(clip: StartripsSignatureClip) {
  const ratios = clip.events
    .filter((entry) => entry.sourceEndMs > entry.sourceStartMs && entry.clipEndMs > entry.clipStartMs)
    .map((entry) => (entry.clipEndMs - entry.clipStartMs) / (entry.sourceEndMs - entry.sourceStartMs));
  if (ratios.length < 2) return false;
  return ratios.every((ratio) => Math.abs(ratio - ratios[0]) < 0.0001);
}

export type StartripsSignaturePose = {
  rootX: number;
  rootY: number;
  bodyY: number;
  headRotateDeg: number;
  eyeX: number;
  eyeY: number;
  starX: number;
  starY: number;
  starScale: number;
  legFnY: number;
  legFnRotateDeg: number;
  legFfY: number;
  legFfRotateDeg: number;
  legHnY: number;
  legHnRotateDeg: number;
  legHfY: number;
  legHfRotateDeg: number;
};

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value));
}

function smoothstep(start: number, end: number, value: number) {
  if (end <= start) return value >= end ? 1 : 0;
  const t = clamp01((value - start) / (end - start));
  return t * t * (3 - 2 * t);
}

function pulse(start: number, peak: number, end: number, value: number) {
  if (value <= start || value >= end) return 0;
  if (value <= peak) return smoothstep(start, peak, value);
  return 1 - smoothstep(peak, end, value);
}

const REST_POSE: StartripsSignaturePose = {
  rootX: 0, rootY: 0, bodyY: 0, headRotateDeg: 0, eyeX: 0, eyeY: 0,
  starX: 0, starY: 0, starScale: 1,
  legFnY: 0, legFnRotateDeg: 0, legFfY: 0, legFfRotateDeg: 0,
  legHnY: 0, legHnRotateDeg: 0, legHfY: 0, legHfRotateDeg: 0,
};

function clipEvent(clip: StartripsSignatureClip, id: string) {
  const entry = clip.events.find((candidate) => candidate.id === id);
  if (!entry) throw new Error(`Clip ${clip.name} is missing required event: ${id}`);
  return entry;
}

function eventPulse(clip: StartripsSignatureClip, id: string, elapsedMs: number) {
  const entry = clipEvent(clip, id);
  return pulse(entry.clipStartMs, (entry.clipStartMs + entry.clipEndMs) / 2, entry.clipEndMs, elapsedMs);
}

export function sampleStartripsSignaturePose(name: StartripsSignatureClipName, elapsedMs: number): StartripsSignaturePose {
  const clip = getStartripsSignatureClip(name);
  const t = Math.max(0, Math.min(clip.durationMs, elapsedMs));
  if (t >= clip.durationMs) return { ...REST_POSE };

  const noticeEvent = clipEvent(clip, "notice-head");
  const notice = smoothstep(noticeEvent.clipStartMs, noticeEvent.clipEndMs, t);
  const frontNearEvent = clipEvent(clip, "front-near-climb");
  const frontNear = eventPulse(clip, "front-near-climb", t);
  const frontFar = eventPulse(clip, "front-far-climb", t);
  const hindNear = eventPulse(clip, "hind-near-transfer", t);
  const hindFar = eventPulse(clip, "hind-far-transfer", t);
  const foreHome = clipEvent(clip, "fore-near-home");
  const hindHome = clipEvent(clip, "hind-far-home");
  const settle = smoothstep(
    Math.min(foreHome.clipStartMs, hindHome.clipStartMs),
    Math.max(foreHome.clipEndMs, hindHome.clipEndMs),
    t,
  );
  const support = Math.max(frontNear, frontFar, hindNear, hindFar);

  if (name !== "full") {
    const approach = 1 - smoothstep(noticeEvent.clipStartMs, foreHome.clipStartMs, t);
    const starPulseStart = noticeEvent.clipEndMs * 0.68;
    return {
      rootX: 8 * approach * (1 - settle),
      rootY: (3 * approach - 2.4 * support) * (1 - settle),
      bodyY: -1.8 * support * (1 - settle),
      headRotateDeg: -15 * (1 - notice) * (1 - settle),
      eyeX: -1.2 * (1 - notice) * (1 - settle),
      eyeY: -0.25 * (1 - notice) * (1 - settle),
      starX: 0,
      starY: -2.2 * (1 - notice),
      starScale: 0.9 + 0.1 * notice + 0.045 * pulse(
        starPulseStart,
        noticeEvent.clipEndMs * 0.95,
        frontNearEvent.clipStartMs,
        t,
      ),
      legFnY: -8 * frontNear * (1 - settle),
      legFnRotateDeg: -9 * frontNear * (1 - settle),
      legFfY: -6.5 * frontFar * (1 - settle),
      legFfRotateDeg: -7 * frontFar * (1 - settle),
      legHnY: -7.5 * hindNear * (1 - settle),
      legHnRotateDeg: 8 * hindNear * (1 - settle),
      legHfY: -6.5 * hindFar * (1 - settle),
      legHfRotateDeg: 7 * hindFar * (1 - settle),
    };
  }

  const followEvent = clipEvent(clip, "follow-star");
  const leapEvent = clipEvent(clip, "final-leap");
  const follow = smoothstep(followEvent.clipStartMs, followEvent.clipStartMs + (followEvent.clipEndMs - followEvent.clipStartMs) * 0.18, t)
    * (1 - smoothstep(followEvent.clipEndMs - (followEvent.clipEndMs - followEvent.clipStartMs) * 0.12, followEvent.clipEndMs, t));
  const leap = eventPulse(clip, "final-leap", t);
  const followProgress = clamp01((t - followEvent.clipStartMs) / Math.max(1, followEvent.clipEndMs - followEvent.clipStartMs));
  const starWave = Math.sin(followProgress * Math.PI * 1.35) * follow;
  const approach = 1 - smoothstep(noticeEvent.clipEndMs, followEvent.clipStartMs, t);
  return {
    rootX: 10 * approach * (1 - settle),
    rootY: (-2.5 * support - 8 * leap) * (1 - settle),
    bodyY: (-2 * support - 2.2 * leap) * (1 - settle),
    headRotateDeg: (-16 * (1 - notice) + 8 * starWave) * (1 - settle),
    eyeX: (-1.2 * (1 - notice) - 1.1 * starWave) * (1 - settle),
    eyeY: (-0.25 * (1 - notice) + 0.3 * starWave) * (1 - settle),
    starX: 11 * starWave,
    starY: -5 * Math.cos(followProgress * Math.PI) * follow,
    starScale: 0.9 + 0.1 * notice + 0.06 * follow,
    legFnY: (-8 * frontNear - 3 * leap) * (1 - settle),
    legFnRotateDeg: (-9 * frontNear - 4 * leap) * (1 - settle),
    legFfY: (-6.5 * frontFar - 2 * leap) * (1 - settle),
    legFfRotateDeg: (-7 * frontFar + 3 * leap) * (1 - settle),
    legHnY: (-7.5 * hindNear + 2 * leap) * (1 - settle),
    legHnRotateDeg: (8 * hindNear + 4 * leap) * (1 - settle),
    legHfY: (-6.5 * hindFar + 2.5 * leap) * (1 - settle),
    legHfRotateDeg: (7 * hindFar - 3 * leap) * (1 - settle),
  };
}
