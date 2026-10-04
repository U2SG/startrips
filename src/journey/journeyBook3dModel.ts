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

/**
 * The orthographic half-height that fits the book in a stage of `aspect`
 * (width / height): a spread in landscape, one page in portrait, with a
 * margin. World page height is 1.
 */
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

export function cameraHalfHeight(aspect: number, pageWidth: number, orientation: JourneyBookOrientation): number {
  const padding = 1.08;
  const width = (orientation === "landscape" ? pageWidth * 2 : pageWidth) * padding;
  return Math.max(padding / 2, width / (2 * Math.max(aspect, 1e-3)));
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
