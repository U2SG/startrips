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
  source: PageSource | null;
  /** Characters of the page's note shown so far; Infinity shows it all. */
  revealed: number;
};

const PAPER = "#f7f6f0";
const INK = "#292c26";
const MUTED = "#73766c";
const CLOTH = "#7d8572";
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
    const titleBlock = fitText(context, input.title, width * 0.76, height * 0.2, Math.round(60 * scale), Math.round(36 * scale), 1.18);
    context.fillStyle = CLOTH_INK;
    drawRevealed(context, titleBlock, width * 0.135, height * 0.1, Infinity, "left", width * 0.76);
    context.font = `${Math.round(20 * scale)}px ${SANS}`;
    context.fillText(input.dates, width * 0.135, height * 0.1 + titleBlock.lines.length * titleBlock.lineHeight + 40 * scale);
    if (page.asset) {
      drawSource(context, input.source, { x: width * 0.135, y: height * 0.36, width: width * 0.6, height: height * 0.32 }, page.asset.mimeType.startsWith("video/"), scale);
    }
    let result: PaintResult = { noteLength: 0, noteOverflow: false };
    if (page.note) {
      const block = fitText(context, page.note, width * 0.73, height * 0.18, Math.round(24 * scale), Math.round(18 * scale), 1.6);
      context.fillStyle = CLOTH_INK;
      drawRevealed(context, block, width * 0.135, height * 0.73, input.revealed, "left", width * 0.73);
      result = { noteLength: graphemes(block.lines.join("")).length, noteOverflow: block.overflow };
    }
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
