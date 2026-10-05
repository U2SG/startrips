import type { StartripsSignaturePose } from "./startripsSignatureTimeline";

/**
 * "pull": the v12 goat climbs out of a Journey Book cover's emboss and pulls
 * the cover open. Unlike the loading/recovery clips it is not remapped from
 * the authored v12 events (there is no star to notice); it is built from pose
 * keyframes in the goat's own left-facing frame, plus a walk cycle. Where the
 * goat stands, which way it faces and how far the cover lifts belong to the
 * book (`journeyBookGoatPull.ts`), which shares these phase marks.
 */
export const STARTRIPS_PULL_PHASES = {
  /** The emboss lifts into a live goat. */
  wakeEnd: 400,
  /** It turns toward the fore-edge and walks along the cover's foot. */
  walkEnd: 1_200,
  /** It bites the fore-edge. */
  gripEnd: 1_400,
  tug1Peak: 1_600,
  tug1End: 1_800,
  tug2Peak: 2_100,
  tug2End: 2_400,
  /** The heave: past here the cover rises out of reach and the goat lets go. */
  letGo: 2_650,
  /** The cover is handed back to the book's own turn. */
  release: 3_200,
  /** The goat has hopped off and faded; the pose is at rest. */
  end: 3_400,
} as const;

export const STARTRIPS_PULL_DURATION_MS = STARTRIPS_PULL_PHASES.end;

type PoseKey = keyof Omit<StartripsSignaturePose, "rootRotateDeg"> | "rootRotateDeg";
type Keyframe = { at: number; pose: Partial<Record<PoseKey, number>> };

const P = STARTRIPS_PULL_PHASES;

/**
 * Effort reads in the lean (rootRotateDeg rears the goat about its hind
 * hooves), the head and the braced legs: a positive leg angle swings its hoof
 * forward. Missing values are 0 (the rest pose).
 */
const KEYFRAMES: readonly Keyframe[] = [
  { at: 0, pose: {} },
  { at: P.wakeEnd, pose: { bodyY: -1.2, headRotateDeg: 4 } },
  { at: P.walkEnd, pose: {} },
  { at: P.gripEnd, pose: { rootRotateDeg: -4, headRotateDeg: -16, legFnRotateDeg: 6, legFfRotateDeg: 4 } },
  { at: P.tug1Peak, pose: { rootRotateDeg: 12, headRotateDeg: -6, bodyY: 1, legFnRotateDeg: 12, legFfRotateDeg: 10, legHnRotateDeg: 6, legHfRotateDeg: 5 } },
  { at: P.tug1End, pose: { rootRotateDeg: 3, headRotateDeg: -12, legFnRotateDeg: 7, legFfRotateDeg: 5, legHnRotateDeg: 2, legHfRotateDeg: 2 } },
  { at: P.tug2Peak, pose: { rootRotateDeg: 20, headRotateDeg: -2, bodyY: 1.5, legFnRotateDeg: 16, legFfRotateDeg: 13, legHnRotateDeg: 8, legHfRotateDeg: 7 } },
  { at: P.tug2End, pose: { rootRotateDeg: 8, headRotateDeg: -10, bodyY: 0.5, legFnRotateDeg: 10, legFfRotateDeg: 8, legHnRotateDeg: 4, legHfRotateDeg: 3 } },
  { at: (P.tug2End + P.letGo) / 2, pose: { rootRotateDeg: 28, headRotateDeg: 4, bodyY: 1.5, legFnRotateDeg: 18, legFfRotateDeg: 15, legHnRotateDeg: 10, legHfRotateDeg: 9 } },
  { at: P.letGo, pose: { rootRotateDeg: 24, headRotateDeg: 6, bodyY: 1, legFnRotateDeg: 14, legFfRotateDeg: 12, legHnRotateDeg: 8, legHfRotateDeg: 7 } },
  // The hop: legs tuck in the air, then reach for the table.
  { at: (P.letGo + P.release) / 2, pose: { rootRotateDeg: -6, bodyY: -1, legFnY: -3, legFnRotateDeg: -10, legFfY: -2.5, legFfRotateDeg: -8, legHnY: -3, legHnRotateDeg: 10, legHfY: -2.5, legHfRotateDeg: 8 } },
  { at: P.release, pose: { legFnRotateDeg: 4, legFfRotateDeg: 3 } },
  { at: P.end, pose: {} },
];

/** Strides in the walk, and how far a stride swings each leg (degrees, units). */
const WALK_STRIDES = 3;
const WALK_SWING_DEG = 14;
const WALK_LIFT = 3;
const WALK_BOB = 1;

function smoothstep(value: number) {
  const t = Math.max(0, Math.min(1, value));
  return t * t * (3 - 2 * t);
}

function keyed(key: PoseKey, t: number): number {
  let index = 0;
  while (index < KEYFRAMES.length - 2 && KEYFRAMES[index + 1].at <= t) index += 1;
  const from = KEYFRAMES[index];
  const to = KEYFRAMES[index + 1];
  const mix = smoothstep((t - from.at) / (to.at - from.at));
  const a = from.pose[key] ?? 0;
  const b = to.pose[key] ?? 0;
  return a + (b - a) * mix;
}

/** The walk's leg cycle, eased in and out at the ends of the walk. */
function walkCycle(t: number) {
  const start = P.wakeEnd;
  const span = P.walkEnd - start;
  if (t <= start || t >= P.walkEnd) return null;
  const local = (t - start) / span;
  const envelope = smoothstep(local / 0.15) * smoothstep((1 - local) / 0.15);
  const phase = local * WALK_STRIDES * 2 * Math.PI;
  const swing = Math.sin(phase) * envelope;
  const liftNear = Math.max(0, Math.sin(phase)) * envelope;
  const liftFar = Math.max(0, -Math.sin(phase)) * envelope;
  return {
    bodyY: -WALK_BOB * Math.abs(Math.sin(phase)) * envelope,
    legFnY: -WALK_LIFT * liftNear,
    legFnRotateDeg: WALK_SWING_DEG * swing,
    legHfY: -WALK_LIFT * liftNear,
    legHfRotateDeg: WALK_SWING_DEG * swing * 0.85,
    legFfY: -WALK_LIFT * liftFar,
    legFfRotateDeg: -WALK_SWING_DEG * swing,
    legHnY: -WALK_LIFT * liftFar,
    legHnRotateDeg: -WALK_SWING_DEG * swing * 0.85,
  } satisfies Partial<Record<PoseKey, number>>;
}

const POSE_KEYS: readonly PoseKey[] = [
  "rootX", "rootY", "rootRotateDeg", "bodyY", "headRotateDeg", "eyeX", "eyeY",
  "starX", "starY", "starScale",
  "legFnY", "legFnRotateDeg", "legFfY", "legFfRotateDeg",
  "legHnY", "legHnRotateDeg", "legHfY", "legHfRotateDeg",
];

/** The goat's articulation `elapsedMs` into the pull; at rest at 0 and from the end on. */
export function sampleStartripsPullPose(elapsedMs: number): Required<StartripsSignaturePose> {
  const t = Math.max(0, Math.min(STARTRIPS_PULL_DURATION_MS, Number.isFinite(elapsedMs) ? elapsedMs : 0));
  const walk = walkCycle(t);
  const pose = {} as Required<StartripsSignaturePose>;
  for (const key of POSE_KEYS) {
    pose[key] = (key === "starScale" ? 1 : 0) + keyed(key, t) + ((walk as Partial<Record<PoseKey, number>> | null)?.[key] ?? 0);
  }
  return pose;
}
