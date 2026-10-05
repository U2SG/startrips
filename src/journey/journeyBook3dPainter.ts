import { STARTRIPS_V12_MARK_MARKUP, STARTRIPS_V12_MARK_VIEWBOX } from "../brand/startripsV12Mark";
import {
  COVER_ROUTE_BAND,
  COVER_ROUTE_STROKE,
  fitCoverDateLine,
  type CoverRouteGeometry,
  type CoverRouteVec,
} from "./coverRouteGeometry";
import type { JourneyBookPage } from "./journeyBookPages";

/**
 * #393 3D Journey Book: each page face is painted on a canvas and used as
 * the texture of that face, so pictures and words bend with the paper. The
 * layout follows the 2D book (reference proportions, paper, cloth, plate).
 */

/** Punctuation that may not begin a line. */
const NO_LINE_START = new Set("，。！？、；：,.!?;:)）」』】》〉”’…—");

function graphemes(text: string): string[] {
  if (typeof Intl !== "undefined" && "Segmenter" in Intl) {
    const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    return Array.from(segmenter.segment(text), (part) => part.segment);
  }
  return Array.from(text);
}

/**
 * Units that wrap: a run of Latin letters or digits stays whole; every other
 * grapheme (CJK, punctuation, space) is a unit of its own.
 */
export function wrapUnits(text: string): string[] {
  const units: string[] = [];
  let word = "";
  for (const grapheme of graphemes(text)) {
    if (/^[\p{Script=Latin}\p{N}'’-]$/u.test(grapheme)) {
      word += grapheme;
      continue;
    }
    if (word) {
      units.push(word);
      word = "";
    }
    units.push(grapheme);
  }
  if (word) units.push(word);
  return units;
}

/**
 * Lines of `text` no wider than `maxWidth` by `measure`. Paragraph breaks
 * are kept; a line never starts with closing punctuation, and spaces at a
 * line break are dropped.
 */
export function wrapLines(text: string, maxWidth: number, measure: (value: string) => number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split(/\r?\n/)) {
    let line = "";
    for (const unit of wrapUnits(paragraph)) {
      const next = line + unit;
      if (!line || measure(next) <= maxWidth || NO_LINE_START.has(unit)) {
        line = next;
        continue;
      }
      lines.push(line.trimEnd());
      line = unit === " " ? "" : unit;
    }
    lines.push(line.trimEnd());
  }
  return lines;
}

export type PageSource =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; image: CanvasImageSource; width: number; height: number };

export type PaintInput = {
  page: JourneyBookPage;
  face: number;
  faceCount: number;
  title: string;
  dates: string;
  /** The Journey's Route Points, counted on the cover. */
  routePointCount: number;
  /** The cover's debossed Route (`coverRouteGeometry`). */
  route: CoverRouteGeometry;
  source: PageSource | null;
  /** Characters of the page's note shown so far; Infinity shows it all. */
  revealed: number;
};

const PAPER = "#f7f6f0";
const INK = "#292c26";
const MUTED = "#73766c";
const CLOTH = "#5f6b73";
const PLATE_MOUNT = "#ece7d6";
const FOIL = "#e4cf98";
const CLOTH_INK = "#f2efdf";
const ENDPAPER = "#e9e9dc";
const SERIF = 'Georgia, "Songti SC", "STSong", "Noto Serif CJK SC", serif';
const SANS = 'Inter, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif';

/** Plate of a picture page, as fractions of the page. Shared with the video overlay. */
export const PLATE = { left: 0.07, top: 0.07, width: 0.86, height: 0.8 } as const;

let grainTile: HTMLCanvasElement | null = null;

/** A small deterministic paper grain, tiled under every page. */
function grain(): HTMLCanvasElement {
  if (grainTile) return grainTile;
  const tile = document.createElement("canvas");
  tile.width = tile.height = 128;
  const context = tile.getContext("2d")!;
  const data = context.createImageData(128, 128);
  let seed = 0x2f6b;
  for (let index = 0; index < data.data.length; index += 4) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const value = 120 + (seed % 60);
    data.data[index] = data.data[index + 1] = data.data[index + 2] = value;
    data.data[index + 3] = 10;
  }
  context.putImageData(data, 0, 0);
  grainTile = tile;
  return tile;
}

function fillPaper(context: CanvasRenderingContext2D, width: number, height: number, color: string) {
  context.fillStyle = color;
  context.fillRect(0, 0, width, height);
  const pattern = context.createPattern(grain(), "repeat");
  if (pattern) {
    context.fillStyle = pattern;
    context.fillRect(0, 0, width, height);
  }
}

/** The inner edge darkens toward the spine; a right-hand page's spine is on its left. */
function spineShade(context: CanvasRenderingContext2D, width: number, height: number, face: number) {
  const span = width * 0.1;
  const spineLeft = face % 2 === 0;
  const gradient = spineLeft
    ? context.createLinearGradient(0, 0, span, 0)
    : context.createLinearGradient(width, 0, width - span, 0);
  gradient.addColorStop(0, "rgb(28 30 24 / 0.22)");
  gradient.addColorStop(0.4, "rgb(28 30 24 / 0.06)");
  gradient.addColorStop(1, "rgb(28 30 24 / 0)");
  context.fillStyle = gradient;
  context.fillRect(spineLeft ? 0 : width - span, 0, span, height);
}

function containRect(box: { x: number; y: number; width: number; height: number }, sourceWidth: number, sourceHeight: number) {
  const scale = Math.min(box.width / sourceWidth, box.height / sourceHeight);
  const width = sourceWidth * scale;
  const height = sourceHeight * scale;
  return { x: box.x + (box.width - width) / 2, y: box.y + (box.height - height) / 2, width, height };
}

function drawSource(
  context: CanvasRenderingContext2D,
  source: PageSource | null,
  box: { x: number; y: number; width: number; height: number },
  video: boolean,
  scale: number,
) {
  if (source?.status === "ready") {
    const rect = containRect(box, source.width, source.height);
    context.drawImage(source.image, rect.x, rect.y, rect.width, rect.height);
    if (video) drawPlayGlyph(context, rect, scale);
    return rect;
  }
  if (video) {
    context.fillStyle = "#16181a";
    context.fillRect(box.x, box.y, box.width, box.height);
    drawPlayGlyph(context, box, scale);
  }
  context.fillStyle = video ? "rgb(242 239 223 / 0.7)" : MUTED;
  context.font = `${Math.round(22 * scale)}px ${SANS}`;
  context.textAlign = "center";
  context.textBaseline = "middle";
  const label = source?.status === "error" ? source.message : source ? "正在翻到这一页…" : "";
  if (label) context.fillText(label, box.x + box.width / 2, box.y + box.height / 2 + (video ? 70 * scale : 0));
  return box;
}

function drawPlayGlyph(context: CanvasRenderingContext2D, rect: { x: number; y: number; width: number; height: number }, scale: number) {
  const size = 34 * scale;
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;
  context.fillStyle = "rgb(2 7 6 / 0.5)";
  context.fillRect(cx - size * 1.3, cy - size * 1.3, size * 2.6, size * 2.6);
  context.fillStyle = "rgb(255 248 231 / 0.92)";
  context.beginPath();
  context.moveTo(cx - size * 0.45, cy - size * 0.65);
  context.lineTo(cx + size * 0.7, cy);
  context.lineTo(cx - size * 0.45, cy + size * 0.65);
  context.closePath();
  context.fill();
}

type TextBlock = { lines: string[]; fontSize: number; lineHeight: number; overflow: boolean };

/** Fit text into a box, shrinking the type down to `minSize`, then cutting with an ellipsis. */
function fitText(
  context: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  maxHeight: number,
  size: number,
  minSize: number,
  lineRatio: number,
): TextBlock {
  for (let fontSize = size; ; fontSize = Math.max(minSize, fontSize - 2)) {
    context.font = `${fontSize}px ${SERIF}`;
    const lines = wrapLines(text, maxWidth, (value) => context.measureText(value).width);
    const lineHeight = fontSize * lineRatio;
    const fits = Math.floor(maxHeight / lineHeight);
    if (lines.length <= fits) return { lines, fontSize, lineHeight, overflow: false };
    if (fontSize === minSize) {
      const kept = lines.slice(0, Math.max(1, fits));
      kept[kept.length - 1] = `${kept[kept.length - 1].slice(0, -1)}…`;
      return { lines: kept, fontSize, lineHeight, overflow: true };
    }
  }
}

/**
 * Draw lines with the first `revealed` characters fully inked and the next
 * few fading and rising in, so the note arrives a character at a time
 * without reflowing.
 */
function drawRevealed(
  context: CanvasRenderingContext2D,
  block: TextBlock,
  x: number,
  y: number,
  revealed: number,
  align: "left" | "center",
  maxWidth: number,
) {
  context.font = `${block.fontSize}px ${SERIF}`;
  context.textBaseline = "alphabetic";
  context.textAlign = "left";
  const base = context.fillStyle;
  let count = 0;
  block.lines.forEach((line, index) => {
    const lineY = y + block.lineHeight * (index + 0.8);
    const lineWidth = context.measureText(line).width;
    let cursor = align === "center" ? x + (maxWidth - lineWidth) / 2 : x;
    for (const character of graphemes(line)) {
      const visibility = Math.max(0, Math.min(1, revealed - count));
      count += 1;
      const width = context.measureText(character).width;
      if (visibility > 0) {
        context.globalAlpha = visibility;
        context.fillStyle = base;
        context.fillText(character, cursor, lineY + (1 - visibility) * block.fontSize * 0.3);
      }
      cursor += width;
    }
  });
  context.globalAlpha = 1;
}

/** Reference cover proportions (504 × 600), as fractions of the cover. */
const COVER = {
  inset: 0.095,
  top: 0.087,
  bottom: 0.073,
  titleSize: 0.067,
  titleWidth: 0.6,
  datesGap: 0.028,
  datesSize: 0.022,
  mark: { width: 0.0675, height: 0.05 },
  plate: { width: 0.3, height: 0.187, mount: 0.01 },
  note: { left: 0.2, rightWithPlate: 0.43, size: 0.022, maxHeight: 0.187 },
} as const;

/** Raster height of the mark; it is drawn at about a tenth of this. */
const MARK_RASTER = 480;
let markImage: HTMLImageElement | null = null;
let markLoad: Promise<void> | null = null;

/**
 * The v12 mark rasterised once for the cover's blind emboss: one opaque tone
 * (drawn at low alpha, so overlapping parts do not darken), cutouts in the
 * cloth colour. Resolves when the image can be drawn.
 */
export function loadCoverMark(): Promise<void> {
  if (markLoad) return markLoad;
  const [, , viewWidth, viewHeight] = STARTRIPS_V12_MARK_VIEWBOX.split(" ").map(Number);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${STARTRIPS_V12_MARK_VIEWBOX}" `
    + `width="${Math.round((MARK_RASTER * viewWidth) / viewHeight)}" height="${MARK_RASTER}" `
    + `style="color:#000;--startrips-brand-cutout:${CLOTH}">`
    + "<style>.goat-fill{fill:currentColor}.far-fill{fill:currentColor;opacity:.72}</style>"
    + `${STARTRIPS_V12_MARK_MARKUP}</svg>`;
  const image = new Image();
  markLoad = new Promise<void>((resolve) => {
    image.onload = () => {
      markImage = image;
      resolve();
    };
    // Without the mark the cover is still complete.
    image.onerror = () => resolve();
  });
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  return markLoad;
}

/** Whether the cover mark is ready to draw; part of a cover's repaint signature. */
export function coverMarkReady(): boolean {
  return markImage !== null;
}

/** Cover-fit `source` into `box`, clipped to it. */
function drawCovered(
  context: CanvasRenderingContext2D,
  source: PageSource | null,
  box: { x: number; y: number; width: number; height: number },
  scale: number,
) {
  if (source?.status === "ready") {
    const fit = Math.max(box.width / source.width, box.height / source.height);
    const width = source.width * fit;
    const height = source.height * fit;
    context.save();
    context.beginPath();
    context.rect(box.x, box.y, box.width, box.height);
    context.clip();
    context.drawImage(source.image, box.x + (box.width - width) / 2, box.y + (box.height - height) / 2, width, height);
    context.restore();
    return;
  }
  const label = source?.status === "error" ? source.message : source ? "正在翻到这一页…" : "";
  if (!label) return;
  context.fillStyle = MUTED;
  context.font = `${Math.round(16 * scale)}px ${SANS}`;
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(label, box.x + box.width / 2, box.y + box.height / 2, box.width * 0.9);
}

/** The Journey's Route, blind-debossed into the cloth: start dark, end in foil. */
function drawCoverRoute(context: CanvasRenderingContext2D, route: CoverRouteGeometry, width: number, height: number) {
  if (route.kind === "none") return;
  const band = {
    x: width * COVER_ROUTE_BAND.left,
    y: height * COVER_ROUTE_BAND.top,
    width: width * COVER_ROUTE_BAND.width,
    height: height * COVER_ROUTE_BAND.height,
  };
  const at = (vec: CoverRouteVec) => [band.x + vec.x * band.width, band.y + vec.y * band.height] as const;
  const square = (vec: CoverRouteVec, size: number, color: string) => {
    const [x, y] = at(vec);
    const side = size * width;
    context.fillStyle = color;
    context.fillRect(x - side / 2, y - side / 2, side, side);
  };
  if (route.kind === "path") {
    const trace = (dx: number, dy: number) => {
      context.beginPath();
      const [startX, startY] = at(route.start);
      context.moveTo(startX + dx, startY + dy);
      for (const curve of route.curves) {
        const [c1x, c1y] = at(curve.c1);
        const [c2x, c2y] = at(curve.c2);
        const [toX, toY] = at(curve.to);
        context.bezierCurveTo(c1x + dx, c1y + dy, c2x + dx, c2y + dy, toX + dx, toY + dy);
      }
    };
    context.lineCap = "round";
    context.lineJoin = "round";
    trace(0, 0);
    context.strokeStyle = "rgb(0 0 0 / 0.2)";
    context.lineWidth = COVER_ROUTE_STROKE.deboss * width;
    context.stroke();
    const offset = -COVER_ROUTE_STROKE.highlightOffset * width;
    trace(offset, offset);
    context.strokeStyle = "rgb(255 255 255 / 0.07)";
    context.lineWidth = COVER_ROUTE_STROKE.highlight * width;
    context.stroke();
    square(route.start, COVER_ROUTE_STROKE.start, "rgb(0 0 0 / 0.25)");
  }
  square(route.end, COVER_ROUTE_STROKE.end, FOIL);
}

/**
 * The front cover, "route deboss": title and dates top left, the Route across
 * the middle, the embossed mark and a tipped-in plate along the foot, the
 * Journey note between them. Returns the note's reveal length and overflow.
 */
function paintCover(context: CanvasRenderingContext2D, width: number, height: number, input: PaintInput, scale: number): PaintResult {
  const page = input.page as Extract<JourneyBookPage, { kind: "cover" }>;
  const left = width * COVER.inset;
  const top = height * COVER.top;
  const foot = height * (1 - COVER.bottom);

  context.fillStyle = CLOTH_INK;
  const titleSize = Math.round(width * COVER.titleSize);
  const titleBlock = fitText(context, input.title, width * COVER.titleWidth, titleSize * 1.2 * 2, titleSize, Math.round(titleSize * 0.7), 1.2);
  context.font = `600 ${titleBlock.fontSize}px ${SERIF}`;
  context.textAlign = "left";
  context.textBaseline = "alphabetic";
  titleBlock.lines.forEach((line, index) => {
    context.fillText(line, left, top + titleBlock.lineHeight * (index + 0.8));
  });

  const datesSize = Math.round(width * COVER.datesSize);
  context.save();
  context.globalAlpha = 0.75;
  context.font = `500 ${datesSize}px ${SANS}`;
  context.letterSpacing = `${(datesSize * 0.26).toFixed(1)}px`;
  context.textBaseline = "top";
  const datesWidth = width * (1 - 2 * COVER.inset);
  context.fillText(
    fitCoverDateLine(input.dates, input.routePointCount, (line) => context.measureText(line).width <= datesWidth),
    left,
    top + titleBlock.lines.length * titleBlock.lineHeight + width * COVER.datesGap,
    datesWidth,
  );
  context.restore();

  drawCoverRoute(context, input.route, width, height);

  if (markImage) {
    const box = { x: left, y: foot - height * COVER.mark.height, width: width * COVER.mark.width, height: height * COVER.mark.height };
    const rect = containRect(box, markImage.naturalWidth || markImage.width, markImage.naturalHeight || markImage.height);
    context.save();
    context.globalAlpha = 0.18;
    context.drawImage(markImage, rect.x, box.y + box.height - rect.height, rect.width, rect.height);
    context.restore();
  }

  if (page.asset) {
    const plate = {
      x: width * (1 - COVER.inset - COVER.plate.width),
      y: foot - height * COVER.plate.height,
      width: width * COVER.plate.width,
      height: height * COVER.plate.height,
    };
    context.fillStyle = PLATE_MOUNT;
    context.fillRect(plate.x, plate.y, plate.width, plate.height);
    context.strokeStyle = "rgb(0 0 0 / 0.2)";
    context.lineWidth = Math.max(1, width / 504);
    context.strokeRect(plate.x - context.lineWidth / 2, plate.y - context.lineWidth / 2, plate.width + context.lineWidth, plate.height + context.lineWidth);
    const mount = width * COVER.plate.mount;
    drawCovered(context, input.source, {
      x: plate.x + mount,
      y: plate.y + mount,
      width: plate.width - 2 * mount,
      height: plate.height - 2 * mount,
    }, scale);
  }

  if (!page.note) return { noteLength: 0, noteOverflow: false };
  const noteLeft = width * COVER.note.left;
  const noteWidth = width * (1 - (page.asset ? COVER.note.rightWithPlate : COVER.inset)) - noteLeft;
  const noteSize = Math.round(width * COVER.note.size);
  const block = fitText(context, page.note, noteWidth, height * COVER.note.maxHeight, noteSize, Math.round(noteSize * 0.85), 1.5);
  context.fillStyle = "rgb(242 239 223 / 0.85)";
  drawRevealed(context, block, noteLeft, foot - block.lines.length * block.lineHeight, input.revealed, "left", noteWidth);
  return { noteLength: graphemes(block.lines.join("")).length, noteOverflow: block.overflow };
}

export type PaintResult = {
  /** Number of note characters on this face, for the reveal clock. */
  noteLength: number;
  /** The note was cut to fit; the reader offers the full text. */
  noteOverflow: boolean;
};

/** Paint one face. `canvas` is reused across repaints of the same face. */
export function paintFace(canvas: HTMLCanvasElement, input: PaintInput): PaintResult {
  const context = canvas.getContext("2d")!;
  const { width, height } = canvas;
  const scale = height / 1024;
  const { page } = input;
  context.save();
  context.clearRect(0, 0, width, height);

  if (page.kind === "cover" || page.kind === "end") {
    fillPaper(context, width, height, CLOTH);
    context.fillStyle = CLOTH_INK;
    if (page.kind === "end") {
      context.font = `${Math.round(26 * scale)}px ${SERIF}`;
      context.textAlign = "left";
      context.fillText(input.title, width * 0.135, height * 0.9);
      context.restore();
      return { noteLength: 0, noteOverflow: false };
    }
    const result = paintCover(context, width, height, input, scale);
    context.restore();
    return result;
  }

  fillPaper(context, width, height, page.kind === "blank" ? ENDPAPER : PAPER);
  spineShade(context, width, height, input.face);
  const folio = () => {
    context.fillStyle = MUTED;
    context.font = `${Math.round(18 * scale)}px ${SERIF}`;
    context.textAlign = input.face % 2 === 1 ? "left" : "right";
    context.textBaseline = "alphabetic";
    context.fillText(String(input.face), input.face % 2 === 1 ? width * 0.077 : width * 0.923, height * 0.955);
  };

  if (page.kind === "blank") {
    context.restore();
    return { noteLength: 0, noteOverflow: false };
  }

  if (page.kind === "note") {
    const left = width * 0.14;
    const textWidth = width * 0.72;
    let top = height * 0.14;
    if (page.routePoint?.label) {
      context.fillStyle = INK;
      const heading = fitText(context, page.routePoint.label, textWidth, height * 0.12, Math.round(40 * scale), Math.round(28 * scale), 1.25);
      drawRevealed(context, heading, left, top, Infinity, "left", textWidth);
      top += heading.lines.length * heading.lineHeight + 36 * scale;
    }
    const block = fitText(context, page.note, textWidth, height * 0.84 - top, Math.round(30 * scale), Math.round(20 * scale), 1.8);
    context.fillStyle = INK;
    drawRevealed(context, block, left, top, input.revealed, "left", textWidth);
    folio();
    context.restore();
    return { noteLength: graphemes(block.lines.join("")).length, noteOverflow: block.overflow };
  }

  const plateBox = {
    x: width * PLATE.left,
    y: height * PLATE.top,
    width: width * PLATE.width,
    height: height * PLATE.height,
  };
  const video = page.asset.mimeType.startsWith("video/");
  const drawn = drawSource(context, input.source, plateBox, video, scale);
  let result: PaintResult = { noteLength: 0, noteOverflow: false };
  if (page.note) {
    // A note laid over the picture with a local scrim; the rest of the
    // picture keeps its pixels.
    const textWidth = drawn.width - 48 * scale;
    const block = fitText(context, page.note, textWidth, drawn.height * 0.42, Math.round(28 * scale), Math.round(20 * scale), 1.65);
    const blockHeight = block.lines.length * block.lineHeight;
    const scrimTop = drawn.y + drawn.height - blockHeight - 72 * scale;
    const scrim = context.createLinearGradient(0, scrimTop, 0, drawn.y + drawn.height);
    scrim.addColorStop(0, "rgb(2 7 6 / 0)");
    scrim.addColorStop(0.4, "rgb(2 7 6 / 0.4)");
    scrim.addColorStop(1, "rgb(2 7 6 / 0.72)");
    context.fillStyle = scrim;
    context.fillRect(drawn.x, scrimTop, drawn.width, drawn.y + drawn.height - scrimTop);
    context.fillStyle = "#fff8e7";
    drawRevealed(context, block, drawn.x + 24 * scale, drawn.y + drawn.height - blockHeight - 24 * scale, input.revealed, "left", textWidth);
    result = { noteLength: graphemes(block.lines.join("")).length, noteOverflow: block.overflow };
  }
  if (page.routePoint?.label) {
    context.fillStyle = MUTED;
    context.font = `${Math.round(20 * scale)}px ${SERIF}`;
    context.textAlign = input.face % 2 === 1 ? "right" : "left";
    context.textBaseline = "alphabetic";
    const label = page.routePoint.label.length > 28 ? `${page.routePoint.label.slice(0, 27)}…` : page.routePoint.label;
    context.fillText(label, input.face % 2 === 1 ? width * 0.923 : width * 0.077, height * 0.955);
  }
  folio();
  context.restore();
  return result;
}

/** All characters of a face's note, for the reveal clock before painting. */
export function noteCharacterCount(text: string | null): number {
  return text ? graphemes(text).length : 0;
}
