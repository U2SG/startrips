import { STARTRIPS_V12_MARK_MARKUP, STARTRIPS_V12_MARK_VIEWBOX } from "../brand/startripsV12Mark";
import {
  COVER_ROUTE_BAND,
  COVER_ROUTE_STROKE,
  coverRouteDots,
  fitCoverDateLine,
  type CoverRouteGeometry,
  type CoverRouteVec,
} from "./coverRouteGeometry";
import {
  COVER_GOLD,
  COVER_GOLD_END,
  COVER_GOLD_LINE,
  COVER_INK,
  COVER_LIFT,
  COVER_MARK_OPACITY,
  COVER_NIGHT,
  COVER_PHOTO_ROUTE,
  COVER_STAR,
  COVER_STAR_BRIGHT,
  COVER_TITLE_BAND,
  coverStarField,
} from "./journeyBookCover";
import { journeyBookCoverStyle, type JourneyBookPage } from "./journeyBookPages";

/**
 * #393 3D Journey Book: each page face is painted on a canvas and used as
 * the texture of that face, so pictures and words bend with the paper. The
 * layout follows the 2D book (reference proportions, paper, cover).
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
  /** The cover's Route (`coverRouteGeometry`). */
  route: CoverRouteGeometry;
  source: PageSource | null;
  /** Characters of the page's note shown so far; Infinity shows it all. */
  revealed: number;
};

const PAPER = "#f7f6f0";
const INK = "#292c26";
/** The Journey note is set heavier and darker than labels, so it reads on lit paper. */
const NOTE_INK = "#1d1f1b";
const NOTE_WEIGHT = 600;
const MUTED = "#73766c";
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

type TextBlock = { lines: string[]; fontSize: number; lineHeight: number; overflow: boolean; weight: number };

/** Fit text into a box, shrinking the type down to `minSize`, then cutting with an ellipsis. */
function fitText(
  context: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  maxHeight: number,
  size: number,
  minSize: number,
  lineRatio: number,
  weight = 400,
): TextBlock {
  for (let fontSize = size; ; fontSize = Math.max(minSize, fontSize - 2)) {
    context.font = `${weight} ${fontSize}px ${SERIF}`;
    const lines = wrapLines(text, maxWidth, (value) => context.measureText(value).width);
    const lineHeight = fontSize * lineRatio;
    const fits = Math.floor(maxHeight / lineHeight);
    if (lines.length <= fits) return { lines, fontSize, lineHeight, overflow: false, weight };
    if (fontSize === minSize) {
      const kept = lines.slice(0, Math.max(1, fits));
      kept[kept.length - 1] = `${kept[kept.length - 1].slice(0, -1)}…`;
      return { lines: kept, fontSize, lineHeight, overflow: true, weight };
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
  context.font = `${block.weight} ${block.fontSize}px ${SERIF}`;
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
} as const;

/** Raster height of the mark; it is drawn at about a tenth of this. */
const MARK_RASTER = 480;
let markImage: HTMLImageElement | null = null;
let markMaterialImage: HTMLImageElement | null = null;
let markLoad: Promise<void> | null = null;

/**
 * Cover material channels (0–255), packed into one texture beside the colour
 * face: R height (128 is the board's surface, lower is pressed in), G
 * roughness, B metalness. A photo cover is the plain surface throughout: no
 * relief over the photo. The starry cover gives its gold Route a gentle
 * groove and its end square a satin foil. With no environment map a metal is
 * lit only by the key light's highlight, and at roughness 0.3 that lobe is too
 * narrow to reach a camera looking down on the book, so the square would read
 * darker than the board; at 0.5 it stays brighter in both light poses and
 * keeps its warm colour.
 */
export const COVER_MATERIAL = {
  surface: [128, 230, 0],
  /** Floor of the Route groove and the start square: a fine impression, a little smoother than the board. */
  deboss: [96, 217, 0],
  /** The blind-stamped mark, shallower than the Route. */
  mark: [104, 217, 0],
  foil: [104, 128, 217],
} as const satisfies Record<string, readonly [number, number, number]>;

/**
 * The Route groove as concentric strokes, widest and shallowest first, so its
 * walls ramp over a few texels instead of a one-texel step. `width` is a
 * multiple of `COVER_ROUTE_STROKE.deboss`, `depth` the fraction of the way
 * from the surface to the groove floor.
 */
export const COVER_GROOVE = [
  { width: 1.1, depth: 1 / 3 },
  { width: 0.8, depth: 2 / 3 },
  { width: 0.5, depth: 1 },
] as const;

type MaterialChannels = readonly [number, number, number];

/** A material colour `depth` of the way from the surface to `to`, as a canvas colour. */
export function coverMaterialColor(to: MaterialChannels, depth = 1): string {
  const [r, g, b] = COVER_MATERIAL.surface.map((from, index) => Math.round(from + (to[index] - from) * depth));
  return `rgb(${r} ${g} ${b})`;
}

/** The v12 mark as an SVG data URL: shapes in `fill`, cutouts in `cutout`. */
function markUrl(fill: string, cutout: string): string {
  const [, , viewWidth, viewHeight] = STARTRIPS_V12_MARK_VIEWBOX.split(" ").map(Number);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${STARTRIPS_V12_MARK_VIEWBOX}" `
    + `width="${Math.round((MARK_RASTER * viewWidth) / viewHeight)}" height="${MARK_RASTER}" `
    + `style="color:${fill};--startrips-brand-cutout:${cutout}">`
    + "<style>.goat-fill{fill:currentColor}.far-fill{fill:currentColor;opacity:.72}</style>"
    + `${STARTRIPS_V12_MARK_MARKUP}</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/** Resolves with the decoded image, or null; without the mark the cover is still complete. */
function loadImage(url: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.src = url;
  });
}

/**
 * The v12 mark rasterised once for the starry cover, twice over: for the
 * colour face in gold (drawn at `COVER_MARK_OPACITY`, so overlapping parts do
 * not brighten) with cutouts in the night colour, and for the material map
 * the mark's channels with cutouts in the surface's. Resolves when both settle.
 */
export function loadCoverMark(): Promise<void> {
  markLoad ??= Promise.all([
    loadImage(markUrl(COVER_GOLD, COVER_NIGHT)),
    loadImage(markUrl(coverMaterialColor(COVER_MATERIAL.mark), coverMaterialColor(COVER_MATERIAL.surface))),
  ]).then(([colour, material]) => {
    markImage = colour;
    markMaterialImage = material;
  });
  return markLoad;
}

/** Whether both cover marks are ready to draw; part of a cover's repaint signature. */
export function coverMarkReady(): boolean {
  return markImage !== null && markMaterialImage !== null;
}

/** Where the mark sits on a cover of `width` × `height`, bottom left. */
function coverMarkRect(image: HTMLImageElement, width: number, height: number) {
  const foot = height * (1 - COVER.bottom);
  const box = { x: width * COVER.inset, y: foot - height * COVER.mark.height, width: width * COVER.mark.width, height: height * COVER.mark.height };
  const rect = containRect(box, image.naturalWidth || image.width, image.naturalHeight || image.height);
  return { ...rect, y: box.y + box.height - rect.height };
}

const COVER_STARS = coverStarField();

/** The starry cover's sky: the faint lift, then the seeded stars. */
function drawCoverSky(context: CanvasRenderingContext2D, width: number, height: number) {
  context.save();
  context.translate(width * COVER_LIFT.x, height * COVER_LIFT.y);
  context.scale(width * COVER_LIFT.radius, height * COVER_LIFT.radius);
  const lift = context.createRadialGradient(0, 0, 0, 0, 0, 1);
  lift.addColorStop(0, COVER_LIFT.color);
  lift.addColorStop(1, "rgb(143 211 232 / 0)");
  context.fillStyle = lift;
  context.fillRect(-2, -2, 4, 4);
  context.restore();

  context.save();
  for (const star of COVER_STARS) {
    context.globalAlpha = star.alpha;
    context.fillStyle = star.bright ? COVER_STAR_BRIGHT : COVER_STAR;
    context.beginPath();
    context.arc(star.x * width, star.y * height, star.radius * width, 0, Math.PI * 2);
    context.fill();
  }
  context.restore();
}

/**
 * The cover photo across the whole cover, cover-fit and centred. While it
 * loads the sky beneath shows; a photo that cannot be read says so at the
 * foot, in the cover's ink.
 */
function drawCoverPhoto(context: CanvasRenderingContext2D, source: PageSource | null, width: number, height: number, scale: number) {
  if (source?.status === "ready") {
    const fit = Math.max(width / source.width, height / source.height);
    const drawnWidth = source.width * fit;
    const drawnHeight = source.height * fit;
    context.drawImage(source.image, (width - drawnWidth) / 2, (height - drawnHeight) / 2, drawnWidth, drawnHeight);
    return;
  }
  if (source?.status !== "error") return;
  context.save();
  context.globalAlpha = 0.75;
  context.fillStyle = COVER_INK;
  context.font = `${Math.round(18 * scale)}px ${SANS}`;
  context.textAlign = "left";
  context.textBaseline = "alphabetic";
  context.fillText(source.message, width * COVER.inset, height * (1 - COVER.bottom), width * (1 - 2 * COVER.inset));
  context.restore();
}

/** `COVER_TITLE_BAND`: a solid band of the night behind the head, full width, sharp edged. */
function drawCoverTitleBand(context: CanvasRenderingContext2D, width: number, height: number) {
  const top = height * COVER_TITLE_BAND.top;
  context.fillStyle = `rgb(${COVER_TITLE_BAND.color} / ${COVER_TITLE_BAND.alpha})`;
  context.fillRect(0, top, width, height * COVER_TITLE_BAND.bottom - top);
}

/**
 * Drawing helpers for the cover's Route on a `width` × `height` canvas; the
 * colour face and the material map share them, so the two line up exactly.
 */
function coverRoutePen(context: CanvasRenderingContext2D, width: number, height: number) {
  const band = {
    x: width * COVER_ROUTE_BAND.left,
    y: height * COVER_ROUTE_BAND.top,
    width: width * COVER_ROUTE_BAND.width,
    height: height * COVER_ROUTE_BAND.height,
  };
  const at = (vec: CoverRouteVec) => [band.x + vec.x * band.width, band.y + vec.y * band.height] as const;
  return {
    dot(vec: CoverRouteVec, size: number, color: string) {
      const [x, y] = at(vec);
      context.fillStyle = color;
      context.beginPath();
      context.arc(x, y, (size * width) / 2, 0, Math.PI * 2);
      context.fill();
    },
    square(vec: CoverRouteVec, size: number, color: string) {
      const [x, y] = at(vec);
      const side = size * width;
      context.fillStyle = color;
      context.fillRect(x - side / 2, y - side / 2, side, side);
    },
    trace(route: Extract<CoverRouteGeometry, { kind: "path" }>) {
      context.beginPath();
      const [startX, startY] = at(route.start);
      context.moveTo(startX, startY);
      for (const curve of route.curves) {
        const [c1x, c1y] = at(curve.c1);
        const [c2x, c2y] = at(curve.c2);
        const [toX, toY] = at(curve.to);
        context.bezierCurveTo(c1x, c1y, c2x, c2y, toX, toY);
      }
      context.lineCap = "round";
      context.lineJoin = "round";
    },
  };
}

type CoverRouteLayer = { color: string; endColor: string; line: number; dot: number; start: number; end: number };

/**
 * The layers the cover's Route is drawn in: on a photo a dark halo, then a
 * light core over it (every halo first, so a crossing never cuts a core); on
 * the starry cover one gold layer, its end square a paler gold.
 */
export function coverRouteLayers(style: "photo" | "starry"): CoverRouteLayer[] {
  if (style === "starry") {
    return [{
      color: COVER_GOLD,
      endColor: COVER_GOLD_END,
      line: COVER_GOLD_LINE,
      dot: COVER_ROUTE_STROKE.dot,
      start: COVER_ROUTE_STROKE.start,
      end: COVER_ROUTE_STROKE.end,
    }];
  }
  return (["halo", "core"] as const).map((layer) => ({
    color: COVER_PHOTO_ROUTE[layer],
    endColor: COVER_PHOTO_ROUTE[layer],
    line: COVER_PHOTO_ROUTE.line[layer],
    dot: COVER_PHOTO_ROUTE.dot[layer],
    start: COVER_PHOTO_ROUTE.start[layer],
    end: COVER_PHOTO_ROUTE.end[layer],
  }));
}

/** The Journey's Route on the cover's colour face, in `coverRouteLayers`. */
function drawCoverRoute(
  context: CanvasRenderingContext2D,
  route: CoverRouteGeometry,
  width: number,
  height: number,
  style: "photo" | "starry",
) {
  if (route.kind === "none") return;
  const pen = coverRoutePen(context, width, height);
  for (const layer of coverRouteLayers(style)) {
    if (route.kind === "path") {
      pen.trace(route);
      context.strokeStyle = layer.color;
      context.lineWidth = layer.line * width;
      context.stroke();
      for (const dot of coverRouteDots(route)) pen.dot(dot, layer.dot, layer.color);
      pen.square(route.start, layer.start, layer.color);
    }
    pen.square(route.end, layer.end, layer.endColor);
  }
}

/**
 * The front cover's material map (`COVER_MATERIAL`), the same size as its
 * colour face and drawn from the same Route and mark geometry. A photo cover
 * is flat; the starry cover's gold Route sits in a gentle groove, its end in
 * foil, and the mark is blind-stamped. Every pixel is opaque, so no channel
 * is premultiplied away.
 */
export function paintCoverMaterial(canvas: HTMLCanvasElement, input: Pick<PaintInput, "page" | "route">) {
  const context = canvas.getContext("2d")!;
  const { width, height } = canvas;
  context.save();
  context.fillStyle = coverMaterialColor(COVER_MATERIAL.surface);
  context.fillRect(0, 0, width, height);
  if (input.page.kind !== "cover" || journeyBookCoverStyle(input.page) === "photo") {
    context.restore();
    return;
  }

  const { route } = input;
  if (route.kind !== "none") {
    const pen = coverRoutePen(context, width, height);
    if (route.kind === "path") {
      pen.trace(route);
      for (const step of COVER_GROOVE) {
        context.strokeStyle = coverMaterialColor(COVER_MATERIAL.deboss, step.depth);
        context.lineWidth = COVER_ROUTE_STROKE.deboss * width * step.width;
        context.stroke();
      }
      for (const dot of coverRouteDots(route)) {
        pen.dot(dot, COVER_ROUTE_STROKE.dot, coverMaterialColor(COVER_MATERIAL.deboss));
      }
      // A one-texel shoulder, then the floor, so the square's walls ramp too.
      const texel = 1 / width;
      pen.square(route.start, COVER_ROUTE_STROKE.start + 2 * texel, coverMaterialColor(COVER_MATERIAL.deboss, 0.5));
      pen.square(route.start, COVER_ROUTE_STROKE.start, coverMaterialColor(COVER_MATERIAL.deboss));
    }
    pen.square(route.end, COVER_ROUTE_STROKE.end, coverMaterialColor(COVER_MATERIAL.foil));
  }

  if (markMaterialImage) {
    const rect = coverMarkRect(markMaterialImage, width, height);
    context.drawImage(markMaterialImage, rect.x, rect.y, rect.width, rect.height);
  }
  context.restore();
}

/**
 * The front cover: the Journey's cover photo across the whole cover under a
 * solid title band, or with none the starry night; title and dates top left, the
 * Route across the middle, and on the starry cover the gold mark at the foot.
 * The Journey note is on the book's first page, never on the cover.
 */
function paintCover(context: CanvasRenderingContext2D, width: number, height: number, input: PaintInput, scale: number): PaintResult {
  const page = input.page as Extract<JourneyBookPage, { kind: "cover" }>;
  const style = journeyBookCoverStyle(page);
  const left = width * COVER.inset;
  const top = height * COVER.top;

  // The sky is drawn under a photo too: it shows while the photo loads, or
  // when the photo cannot be read.
  drawCoverSky(context, width, height);
  if (style === "photo") {
    drawCoverPhoto(context, input.source, width, height, scale);
    drawCoverTitleBand(context, width, height);
  }

  context.save();
  context.fillStyle = COVER_INK;
  const titleSize = Math.round(width * COVER.titleSize);
  const titleBlock = fitText(context, input.title, width * COVER.titleWidth, titleSize * 1.2 * 2, titleSize, Math.round(titleSize * 0.7), 1.2);
  context.font = `600 ${titleBlock.fontSize}px ${SERIF}`;
  context.textAlign = "left";
  context.textBaseline = "alphabetic";
  titleBlock.lines.forEach((line, index) => {
    context.fillText(line, left, top + titleBlock.lineHeight * (index + 0.8));
  });

  const datesSize = Math.round(width * COVER.datesSize);
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

  drawCoverRoute(context, input.route, width, height, style);

  if (style === "starry" && markImage) {
    const rect = coverMarkRect(markImage, width, height);
    context.save();
    context.globalAlpha = COVER_MARK_OPACITY;
    context.drawImage(markImage, rect.x, rect.y, rect.width, rect.height);
    context.restore();
  }

  return { noteLength: 0, noteOverflow: false };
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
    fillPaper(context, width, height, COVER_NIGHT);
    context.fillStyle = COVER_INK;
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
    const block = fitText(context, page.note, textWidth, height * 0.84 - top, Math.round(30 * scale), Math.round(20 * scale), 1.8, NOTE_WEIGHT);
    context.fillStyle = NOTE_INK;
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
    const block = fitText(context, page.note, textWidth, drawn.height * 0.42, Math.round(28 * scale), Math.round(20 * scale), 1.65, NOTE_WEIGHT);
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
