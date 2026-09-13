export type StartripsV12Part =
  | "leg-fn"
  | "leg-ff"
  | "leg-hn"
  | "leg-hf"
  | "head"
  | "eye"
  | "star"
  | "body";

export type StartripsV12AuthoredEvent = {
  id: string;
  part: StartripsV12Part;
  kind: "notice" | "step" | "climb" | "gaze" | "leap" | "settle";
  startMs: number;
  endMs: number;
  note: string;
};

export type StartripsV12AuthoredPhase = {
  id: "notice" | "forehooves" | "hind-transfer" | "tease" | "follow" | "home";
  startMs: number;
  sampleMs: number;
  label: string;
};

/**
 * Extracted from the approved standalone `startrips-logo-motion-v12.html`.
 * Source SHA-256: 7931733faedeaea68f7999d8c2d95e0ee12f475466cbe9714d0b773987d25b91
 *
 * This is the canonical authored timing/order dataset used by product clips.
 * Product consumers ask for semantic clips; they never depend on raw source
 * seconds directly. Geometry remains owned by the existing v12 mark assets.
 */
export const STARTRIPS_V12_AUTHORED_TIMELINE = {
  source: "startrips-logo-motion-v12.html",
  sourceSha256: "7931733faedeaea68f7999d8c2d95e0ee12f475466cbe9714d0b773987d25b91",
  durationMs: 25_400,
  phases: [
    { id: "notice", startMs: 0, sampleMs: 6_400, label: "低头 · 发现" },
    { id: "forehooves", startMs: 3_200, sampleMs: 7_850, label: "前蹄 · 攀住" },
    { id: "hind-transfer", startMs: 7_000, sampleMs: 7_850, label: "后腿 · 跟上" },
    { id: "tease", startMs: 9_600, sampleMs: 13_000, label: "靠近 · 逗留" },
    { id: "follow", startMs: 16_350, sampleMs: 17_700, label: "转头 · 追随" },
    { id: "home", startMs: 19_150, sampleMs: 24_700, label: "轻跃 · 归位" },
  ] satisfies StartripsV12AuthoredPhase[],
  events: [
    { id: "notice-star", part: "star", kind: "gaze", startMs: 0, endMs: 3_200, note: "the same i-dot star is the notice target" },
    { id: "notice-head", part: "head", kind: "notice", startMs: 0, endMs: 3_200, note: "head rises toward the live star before the first climbing step" },
    { id: "notice-eye", part: "eye", kind: "gaze", startMs: 0, endMs: 3_200, note: "eye acquires the live star direction" },
    { id: "front-near-climb", part: "leg-fn", kind: "climb", startMs: 5_820, endMs: 6_630, note: "first forehoof reaches and bears weight" },
    { id: "front-far-climb", part: "leg-ff", kind: "climb", startMs: 6_020, endMs: 6_950, note: "second forehoof follows; forehooves are deliberately staggered" },
    { id: "hind-near-transfer", part: "leg-hn", kind: "climb", startMs: 7_070, endMs: 8_280, note: "rear transfer begins only after forehoof support" },
    { id: "hind-far-transfer", part: "leg-hf", kind: "climb", startMs: 7_310, endMs: 8_540, note: "second rear leg follows in a staggered transfer" },
    { id: "follow-star", part: "star", kind: "gaze", startMs: 16_350, endMs: 24_100, note: "star moves; head and eye continue tracking its live direction" },
    { id: "follow-head", part: "head", kind: "gaze", startMs: 16_350, endMs: 24_100, note: "head direction is derived from star position" },
    { id: "follow-eye", part: "eye", kind: "gaze", startMs: 16_350, endMs: 24_100, note: "pupil direction stays coupled to star position" },
    { id: "final-leap", part: "body", kind: "leap", startMs: 19_440, endMs: 21_560, note: "the only authored leap happens near the end" },
    { id: "fore-near-home", part: "leg-fn", kind: "settle", startMs: 23_220, endMs: 23_740, note: "forehoof returns to final lockup" },
    { id: "hind-far-home", part: "leg-hf", kind: "settle", startMs: 23_770, endMs: 24_290, note: "last hoof settles before final rest" },
  ] satisfies StartripsV12AuthoredEvent[],
} as const;
