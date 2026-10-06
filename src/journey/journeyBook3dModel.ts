/**
 * #393 3D Journey Book: pure reading geometry and gesture rules.
 *
 * The book is Quick FlipBook's sheet model: face `2k` is the front of sheet
 * `k` (a right-hand page), face `2k + 1` its back (a left-hand page). At a
 * settled spread `s` the left face is `2s - 1` and the right face `2s`; the
 * closed front shows face 0 alone and the closed back the last face alone.
 *
 * Gesture rules are adapted from 3D Book 2 in create-photo-flipbook-ui
 * (https://github.com/HaichaoLihc/create-photo-flipbook-ui), MIT License,
 * Copyright (c) 2026 Haichao Li.
 */
import type { JourneyBookOrientation } from "./journeyBookLayout";

export type FaceSide = "closed-front" | "closed-back" | "left" | "right";

/** The spread (settled book progress) at which a face is visible. */
export function spreadOfFace(face: number): number {
  return face % 2 === 1 ? (face + 1) / 2 : face / 2;
}

export function faceSide(face: number, faceCount: number): FaceSide {
  if (face <= 0) return "closed-front";
  if (face >= faceCount - 1) return "closed-back";
  return face % 2 === 1 ? "left" : "right";
}

/** Faces visible at a settled spread, left to right. */
export function facesAtSpread(spread: number, faceCount: number): number[] {
  const sheets = faceCount / 2;
  if (spread <= 0) return [0];
  if (spread >= sheets) return [faceCount - 1];
  return [spread * 2 - 1, spread * 2];
}

/**
 * Horizontal world position the camera centres on. A page is `pageWidth`
 * wide; the spine sits at 0 when the book is open, and a closed book is
 * centred on 0. A spread is framed whole; a single page in portrait.
 */
export function focusX(face: number, faceCount: number, pageWidth: number, orientation: JourneyBookOrientation): number {
  if (orientation === "landscape") return 0;
  const side = faceSide(face, faceCount);
  if (side === "left") return -pageWidth / 2;
  if (side === "right") return pageWidth / 2;
  return 0;
}

/** Vertical gap quick_flipbook leaves between stacked sheets (world units). */
export const BOOK_SHEET_SPACING = 0.0012;

/**
 * Height of the table plane under a book of `sheets` sheets.
 *
 * quick_flipbook stacks each sheet `BOOK_SHEET_SPACING` lower than the one
 * above it, so the page on top of a deep stack lies up to `sheets` gaps below
 * the spine. A fixed table height hid the outer part of that page on large
 * books (the first spreads' left page, the last spreads' right page). The table
 * stays at its original height for small books and sinks below the deepest
 * sheet otherwise.
 */
export function bookTableHeight(sheets: number): number {
  return Math.min(-0.035, -BOOK_SHEET_SPACING * (Math.max(0, sheets) + 1) - 0.005);
}

/**
 * The orthographic camera looks down at the book tilted this far about world X
 * toward the reader, so the near edge of the spread shows the thickness of the
 * page blocks. A flat page stays an axis-aligned rectangle on screen, its
 * height foreshortened by cos(tilt); widths are unchanged.
 */
export const BOOK_CAMERA_TILT = (20 * Math.PI) / 180;

/** Clearance around the book inside the frame (world units). */
const FRAME_MARGIN = 0.05;
const FRAME_WIDTH_PADDING = 1.08;

/**
 * The camera's view window, in world units on the camera plane: `top` and
 * `bottom` are screen-up offsets from the world origin's projection, and
 * `halfWidth` spans either side of the focus.
 */
export type BookFrame = { top: number; bottom: number; halfWidth: number };

/**
 * Screen-up position of a world point under the tilted camera. The camera sits
 * on the +Z side, so the page edge at z = +0.5 is the near (lower) edge.
 */
export function screenUp(y: number, z: number, tilt = BOOK_CAMERA_TILT): number {
  return y * Math.sin(tilt) - z * Math.cos(tilt);
}

/**
 * Frame that fits the book in a stage of `aspect` (width / height): a spread
 * in landscape, one page in portrait. Vertically it holds the book and,
 * below the near edge, the full thickness of a `sheets` book. `lift` (0–1)
 * is how high a page's free edge rises, in page-height units (world page
 * height is 1), with its far corner at z = −0.5: at 1 it holds a page standing
 * upright mid-turn, whose far corner reaches sin(tilt) + cos(tilt)/2 up. Any
 * slack is shared above and below.
 */
export function bookFrame(
  aspect: number,
  pageWidth: number,
  orientation: JourneyBookOrientation,
  sheets: number,
  lift: number,
  tilt = BOOK_CAMERA_TILT,
  out?: BookFrame,
): BookFrame {
  const top = screenUp(Math.max(0, Math.min(1, lift)), -0.5, tilt) + FRAME_MARGIN;
  return fitBookFrame(aspect, pageWidth, orientation, sheets, top, tilt, out);
}

/** Progress a desktop hover lifts the page edge under the pointer. */
export const EDGE_LIFT = 0.055;
/** How high a hover-lifted page's free edge stands, in page-height units. */
export const HOVER_EDGE_HEIGHT = Math.sin(Math.PI * EDGE_LIFT);

/**
 * The frame of a book at rest. It already holds a hover-lifted page edge, so
 * a desktop hover is contained without moving the camera.
 */
export function restBookFrame(
  aspect: number,
  pageWidth: number,
  orientation: JourneyBookOrientation,
  sheets: number,
  tilt = BOOK_CAMERA_TILT,
  out?: BookFrame,
): BookFrame {
  return bookFrame(aspect, pageWidth, orientation, sheets, HOVER_EDGE_HEIGHT, tilt, out);
}

/**
 * The frame's top (screen-up, margin included) while a sheet is in flight:
 * the rest frame's top, or the sheet's highest point plus the margin once the
 * sheet rises past it. `sheetTop` is the measured screen-up of the sheet's
 * deformed geometry, curl included; null when no sheet is in flight.
 */
export function flightFrameTop(sheetTop: number | null, tilt = BOOK_CAMERA_TILT): number {
  const rest = screenUp(HOVER_EDGE_HEIGHT, -0.5, tilt) + FRAME_MARGIN;
  return sheetTop === null || !Number.isFinite(sheetTop) ? rest : Math.max(rest, sheetTop + FRAME_MARGIN);
}

/**
 * Fit a frame whose top (screen-up, margin included) is `top`. It writes into
 * `out` when given, so a caller framing every rendered frame allocates nothing.
 */
export function fitBookFrame(
  aspect: number,
  pageWidth: number,
  orientation: JourneyBookOrientation,
  sheets: number,
  top: number,
  tilt = BOOK_CAMERA_TILT,
  out: BookFrame = { top: 0, bottom: 0, halfWidth: 0 },
): BookFrame {
  const bottom = screenUp(-BOOK_SHEET_SPACING * (Math.max(0, sheets) + 1), 0.5, tilt) - FRAME_MARGIN;
  const width = (orientation === "landscape" ? pageWidth * 2 : pageWidth) * FRAME_WIDTH_PADDING;
  const safeAspect = Math.max(aspect, 1e-3);
  const height = Math.max(top - bottom, width / safeAspect);
  const slack = (height - (top - bottom)) / 2;
  out.top = top + slack;
  out.bottom = bottom - slack;
  out.halfWidth = (height * safeAspect) / 2;
  return out;
}

/**
 * World height of the page a settled side shows. quick_flipbook keeps sheet
 * `r` at `-spacing * r` while unturned and at `-spacing * (sheets - r)` once
 * turned, so the top of the right stack at spread `s` is sheet `s` and the top
 * of the left stack is sheet `s - 1`.
 */
export function restingPageHeight(side: FaceSide, spread: number, sheets: number): number {
  if (side === "left" || side === "closed-back") return -BOOK_SHEET_SPACING * (sheets - spread + 1);
  return -BOOK_SHEET_SPACING * spread;
}

/**
 * Sheets lying in each stack for a book at `progress`. A sheet in flight
 * belongs to neither: blocks drawn for these counts stay under it.
 */
export function stackSheets(progress: number, sheets: number): { left: number; right: number; inFlight: boolean } {
  const turned = Math.max(0, Math.min(sheets, Math.floor(progress + 1e-6)));
  const inFlight = turned < sheets && progress - turned > 1e-6;
  return { left: turned, right: sheets - turned - (inFlight ? 1 : 0), inFlight };
}

/**
 * How stiff a sheet is: the front and back covers (the first and last sheet)
 * are hardcover boards, 1; every interior sheet is paper, 0.
 */
export function sheetStiffness(index: number, sheets: number): number {
  return index === 0 || index === sheets - 1 ? 1 : 0;
}

/** The deformation quick_flipbook's `FlipPage.flip` applies to one sheet. */
export type SheetFlipPose = { rotationZ: number; bendForce: number; twistAngle: number; curveIntensity: number };

/**
 * One sheet's pose at turn `progress` (0–1) toward `direction`, with the page
 * curve at `curveIntensity` as the book passes it. Paper (stiffness 0) gets
 * quick_flipbook's own `FlipPage.flip` formula: a curl (`bend`) and a twist
 * that peak mid-turn. A board (stiffness 1) swings rigidly about the spine:
 * no curl, no twist, and the curve that lifts every resting page near the
 * spine is damped by (1 − sin πt)² more, so it is a small give near the hinge
 * as the board lifts and lands rather than a warp across it. At rest (0 or 1)
 * sin πt is 0, so a board and a sheet of paper rest in exactly the same shape.
 */
export function sheetFlipPose(progress: number, direction: number, curveIntensity: number, stiffness: number): SheetFlipPose {
  const rotationZ = Math.PI * progress;
  const lift = Math.sin(rotationZ);
  const paper = 1 - stiffness;
  return {
    rotationZ,
    bendForce: Math.min((-lift / 2) * paper, -1e-4) * direction,
    twistAngle: (lift / 10) * paper,
    curveIntensity: (-1 + 2 * progress) * (1 - lift) ** (1 + 2 * stiffness) * curveIntensity,
  };
}

export type ScreenRect = { left: number; top: number; width: number; height: number };

/**
 * Where a settled face lies on the stage, in CSS px. `spineX` is the screen x
 * of the spine (or of a closed book's centre); `pixelsPerUnit` the frame's
 * scale; the face's own resting height shifts it on screen under the tilt.
 */
export function faceScreenRect(input: {
  side: FaceSide;
  spread: number;
  sheets: number;
  frame: BookFrame;
  pixelsPerUnit: number;
  spineX: number;
  pageWidth: number;
  tilt?: number;
}): ScreenRect {
  const { side, spread, sheets, frame, pixelsPerUnit, spineX, pageWidth, tilt = BOOK_CAMERA_TILT } = input;
  const width = pageWidth * pixelsPerUnit;
  const y = restingPageHeight(side, spread, sheets);
  const top = (frame.top - screenUp(y, -0.5, tilt)) * pixelsPerUnit;
  const bottom = (frame.top - screenUp(y, 0.5, tilt)) * pixelsPerUnit;
  const left = side === "left" ? spineX - width : side === "right" ? spineX : spineX - width / 2;
  return { left, top, width, height: bottom - top };
}

/** The face the reader is on after one step, and whether paper must turn. */
export function stepFace(
  face: number,
  direction: -1 | 1,
  faceCount: number,
  orientation: JourneyBookOrientation,
): { face: number; turns: boolean } | null {
  if (orientation === "landscape") {
    const spread = spreadOfFace(face);
    const target = Math.max(0, Math.min(faceCount / 2, spread + direction));
    if (target === spread) return null;
    return { face: representativeFace(target, faceCount), turns: true };
  }
  const target = face + direction;
  if (target < 0 || target > faceCount - 1) return null;
  return { face: target, turns: spreadOfFace(target) !== spreadOfFace(face) };
}

/** The face that names a spread: its right-hand page when it has one. */
export function representativeFace(spread: number, faceCount: number): number {
  const faces = facesAtSpread(spread, faceCount);
  return faces[faces.length - 1];
}

/**
 * Which way a horizontal drag turns paper: leftward forward, rightward back.
 * 0 when it cannot turn (a cover in the closed direction), or in portrait
 * when it only moves the reader across the open spread.
 */
export function dragTurnDirection(
  face: number,
  faceCount: number,
  orientation: JourneyBookOrientation,
  deltaX: number,
): -1 | 0 | 1 {
  const spread = spreadOfFace(face);
  const sheets = faceCount / 2;
  if (orientation === "landscape") {
    if (deltaX < 0) return spread < sheets ? 1 : 0;
    return spread > 0 ? -1 : 0;
  }
  const side = faceSide(face, faceCount);
  if ((side === "right" || side === "closed-front") && deltaX < 0) return 1;
  if ((side === "left" || side === "closed-back") && deltaX > 0) return -1;
  return 0;
}

/** Turn fraction (0–1) for a horizontal drag across a page of `pageWidthPx`. */
export function dragFraction(deltaX: number, direction: -1 | 1, pageWidthPx: number, startFraction = 0): number {
  const travel = direction === 1 ? -deltaX : deltaX;
  return Math.max(0, Math.min(1, startFraction + travel / Math.max(1, pageWidthPx)));
}

/** A drag completes its turn past a third of the page, or on a quick flick. */
export function shouldCompleteDrag(fraction: number, elapsedMs: number): boolean {
  return fraction >= 0.32 || (elapsedMs <= 280 && fraction >= 0.12);
}

/**
 * Desktop hover: the page edge under the pointer lifts slightly. Returns the
 * turn direction it would start, or 0 when the pointer is not on an edge.
 */
export function edgePreviewDirection(input: {
  spread: number;
  sheets: number;
  pointerX: number;
  pointerY: number;
  spineX: number;
  centerY: number;
  pageWidth: number;
  pageHeight: number;
  edgeZone: number;
}): -1 | 0 | 1 {
  const { spread, sheets, pointerX, pointerY, spineX, centerY, pageWidth, pageHeight, edgeZone } = input;
  if (sheets <= 0 || Math.abs(pointerY - centerY) > pageHeight / 2) return 0;
  let direction: -1 | 1;
  let edgeX: number;
  if (spread <= 0) {
    direction = 1;
    edgeX = spineX + pageWidth / 2;
  } else if (spread >= sheets) {
    direction = -1;
    edgeX = spineX - pageWidth / 2;
  } else if (pointerX < spineX) {
    direction = -1;
    edgeX = spineX - pageWidth;
  } else {
    direction = 1;
    edgeX = spineX + pageWidth;
  }
  return Math.abs(pointerX - edgeX) <= edgeZone ? direction : 0;
}

/** Today's reading light: the key light above the reader's left shoulder. */
export const READING_KEY = { x: -2.8, y: 5.2, z: 2.7, intensity: 2.4 } as const;
const KEY_DISTANCE = Math.hypot(READING_KEY.x, READING_KEY.y, READING_KEY.z);
const READING_ELEVATION = Math.asin(READING_KEY.y / KEY_DISTANCE);
const READING_AZIMUTH = Math.atan2(READING_KEY.z, READING_KEY.x);
/**
 * The closed cover's raking light: low (30°) from the upper left of the
 * screen (world −X, −Z; screen up is −Z), so each wall of the deboss catches
 * light or falls into shade.
 */
export const RAKING_ELEVATION = (30 * Math.PI) / 180;
const RAKING_AZIMUTH = Math.atan2(-1, -1) + 2 * Math.PI;
/** Progress below this is a hover lift or the start of a drag; the light stays. */
const RAKING_DEAD_ZONE = 0.1;

/**
 * The key light's shadow, tuned for the reading pose. The orthographic shadow
 * camera spans ±`extent` world units on a `mapSize` map; PCF samples
 * ±`radius` texels.
 */
export const KEY_SHADOW = { mapSize: 1024, extent: 3, near: 0.1, far: 14, bias: -0.00025, normalBias: 0.012, radius: 3 } as const;

/**
 * Normal offset a flat receiver needs so that no PCF tap toward a light at
 * `elevation` reads the receiver's own depth as an occluder (acne): the
 * farthest tap lies `reach · cot(elevation)` closer to the light, less the
 * constant depth bias, and a normal offset `n` buys `n / sin(elevation)`.
 */
function acneGuard(elevation: number): number {
  const reach = (KEY_SHADOW.radius * 2 * KEY_SHADOW.extent) / KEY_SHADOW.mapSize;
  const depthBias = -KEY_SHADOW.bias * (KEY_SHADOW.far - KEY_SHADOW.near);
  return (reach / Math.tan(elevation) - depthBias) * Math.sin(elevation);
}

export type KeyLightPose = { x: number; y: number; z: number; intensity: number; shadowNormalBias: number };

const READING_POSE: KeyLightPose = { ...READING_KEY, shadowNormalBias: KEY_SHADOW.normalBias };

/**
 * The key light as the front cover opens: raking while the book is closed on
 * its front cover (progress 0), easing to the reading light by the time the
 * cover lies open (progress 1) and staying there. Elevation and azimuth are
 * interpolated at a fixed distance, so the shadow camera keeps its range;
 * the intensity keeps the irradiance on flat paper constant, so the lowered
 * light changes the relief, not the colour of the cloth. The shadow's normal
 * offset is the tuned reading value scaled by `acneGuard`, so the same margin
 * keeps the flat cover from shadowing itself (acne) at the lower angle; at
 * 30° it is about 0.021, short of the book's thickness, so the book's shadow
 * on the table stays attached. Under reduced motion the light snaps at half
 * way instead of easing.
 */
export function coverKeyLight(progress: number, reduced: boolean): KeyLightPose {
  const p = Math.max(0, Math.min(1, Number.isFinite(progress) ? progress : 0));
  let t: number;
  if (reduced) t = p < 0.5 ? 0 : 1;
  else {
    const x = Math.max(0, Math.min(1, (p - RAKING_DEAD_ZONE) / (1 - RAKING_DEAD_ZONE)));
    t = x * x * (3 - 2 * x);
  }
  if (t >= 1) return { ...READING_POSE };
  const elevation = RAKING_ELEVATION + (READING_ELEVATION - RAKING_ELEVATION) * t;
  const azimuth = RAKING_AZIMUTH + (READING_AZIMUTH - RAKING_AZIMUTH) * t;
  const horizontal = KEY_DISTANCE * Math.cos(elevation);
  return {
    x: horizontal * Math.cos(azimuth),
    y: KEY_DISTANCE * Math.sin(elevation),
    z: horizontal * Math.sin(azimuth),
    intensity: (READING_KEY.intensity * Math.sin(READING_ELEVATION)) / Math.sin(elevation),
    shadowNormalBias: KEY_SHADOW.normalBias * (acneGuard(elevation) / acneGuard(READING_ELEVATION)),
  };
}
