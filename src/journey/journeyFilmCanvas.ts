import { ALL_FORMATS, BlobSource, BufferTarget, CanvasSink, CanvasSource, Input, Mp4OutputFormat, Output, canEncodeVideo } from "mediabunny";
import { sampleMemoryFilmFrame } from "./keepsakeMemoryFilm";
import type { JourneyFilmEncoderInput } from "./journeyFilmExport";
import type { RoutePoint } from "./types";

const BACKGROUND = "#111820";
const INK = "#f1ece2";
const ACCENT = "#d8bf91";
const FONT = '"Microsoft YaHei", "PingFang SC", sans-serif';

/** Schematic only: unwrap the date line, retain every canonical waypoint, never invent a road. */
export function projectFilmRoute(points: readonly RoutePoint[]): Array<{ x: number; y: number }> {
  if (!points.length) return [];
  const latMean = points.reduce((sum, p) => sum + p.latitude, 0) / points.length;
  const longitudeScale = Math.max(0.1, Math.cos(latMean * Math.PI / 180));
  let previous = points[0].longitude;
  const projected = points.map((point) => {
    if (!Number.isFinite(point.longitude) || !Number.isFinite(point.latitude) || Math.abs(point.latitude) > 90 || Math.abs(point.longitude) > 180) throw new Error("journey_film_coordinates_invalid");
    let longitude = point.longitude;
    while (longitude - previous > 180) longitude -= 360;
    while (longitude - previous < -180) longitude += 360;
    previous = longitude;
    return { x: longitude * longitudeScale, y: -point.latitude };
  });
  const xs = projected.map((p) => p.x), ys = projected.map((p) => p.y);
  const minX = Math.min(...xs), minY = Math.min(...ys);
  const spanX = Math.max(...xs) - minX, spanY = Math.max(...ys) - minY;
  const scale = Math.max(spanX, spanY, 0.001);
  return projected.map((p) => ({ x: 0.5 + (p.x - minX - spanX / 2) / scale, y: 0.5 + (p.y - minY - spanY / 2) / scale }));
}

function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const { segment } of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)) {
    if (segment === "\n") { lines.push(line); line = ""; continue; }
    if (line && ctx.measureText(line + segment).width > maxWidth) { lines.push(line); line = ""; }
    line += segment;
  }
  if (line) lines.push(line);
  return lines;
}

function contain(ctx: CanvasRenderingContext2D, image: CanvasImageSource, sourceWidth: number, sourceHeight: number, width: number, height: number) {
  const ratio = Math.min(width / sourceWidth, height / sourceHeight);
  const w = sourceWidth * ratio, h = sourceHeight * ratio;
  ctx.drawImage(image, (width - w) / 2, (height - h) / 2, w, h);
}

/** Frame-exact WebCodecs + MP4 muxing, not a screen recording or renamed WebM. */
export async function encodeJourneyFilm(input: JourneyFilmEncoderInput): Promise<Blob> {
  const { journey, film, sourcePlan, signal } = input;
  const { width, height } = film.manifest.output;
  const fps = film.manifest.fps;
  signal.throwIfAborted();
  if (!await canEncodeVideo("avc", { width, height, bitrate: 4_000_000 })) throw new Error("journey_film_codec_unavailable");
  signal.throwIfAborted();
  const canvas = document.createElement("canvas");
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) throw new Error("journey_film_canvas_unavailable");
  await document.fonts.ready;
  const target = new BufferTarget();
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: "in-memory" }), target });
  const source = new CanvasSource(canvas, { codec: "avc", bitrate: 4_000_000 });
  output.addVideoTrack(source, { frameRate: fps });
  const assets = new Map(journey.media.map((asset) => [asset.id, asset]));
  const points = projectFilmRoute(journey.routePoints);
  const pointIndex = new Map(journey.routePoints.map((p, index) => [p.id, index]));
  let picture: ImageBitmap | null = null;
  let opening: ImageBitmap | null = null;
  let videoInput: Input | null = null;
  let videoFrames: ReturnType<CanvasSink["canvasesAtTimestamps"]> | null = null;
  let activeShot = -1;
  const abort = () => { videoInput?.dispose(); void output.cancel().catch(() => {}); };
  signal.addEventListener("abort", abort, { once: true });
  const releaseMedia = async () => {
    if (videoFrames) await videoFrames.return().catch(() => {});
    videoFrames = null;
    videoInput?.dispose(); videoInput = null;
    picture?.close(); picture = null;
  };
  const margin = Math.min(width, height) * 0.075;
  const fontSize = Math.min(width, height) * 0.034;
  const drawCaption = (text: string) => {
    ctx.font = `${fontSize}px ${FONT}`;
    const lines = wrapText(ctx, text, width - 2 * margin);
    const lineHeight = fontSize * 1.55;
    const boxHeight = lines.length * lineHeight + margin;
    ctx.fillStyle = "rgba(10, 16, 23, 0.88)";
    ctx.fillRect(0, height - boxHeight, width, boxHeight);
    ctx.fillStyle = INK; ctx.textAlign = "left"; ctx.textBaseline = "top";
    lines.forEach((line, index) => ctx.fillText(line, margin, height - boxHeight + margin / 2 + index * lineHeight));
  };
  try {
    await output.start();
    signal.throwIfAborted();
    if (input.readOpening) {
      opening = await createImageBitmap(await input.readOpening());
      signal.throwIfAborted();
    }
    for (let frame = 0; frame < film.manifest.totalFrames; frame++) {
      signal.throwIfAborted();
      const state = sampleMemoryFilmFrame(film.manifest, frame);
      const entry = sourcePlan.scenes[state.sourceSceneIndex];
      const shot = film.manifest.shots[state.sourceSceneIndex];
      const scene = entry.scene;
      if (activeShot !== state.sourceSceneIndex) {
        await releaseMedia();
        activeShot = state.sourceSceneIndex;
        if (scene.kind === "media") {
          const asset = assets.get(scene.mediaAssetId);
          if (!asset) throw new Error("journey_film_source_changed");
          const blob = await input.readMedia(asset);
          signal.throwIfAborted();
          if (scene.mediaType === "image") {
            picture = await createImageBitmap(blob);
          } else {
            videoInput = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
            const track = await videoInput.getPrimaryVideoTrack();
            if (!track || !await track.canDecode()) throw new Error("journey_film_video_unsupported");
            const start = Math.max(0, await track.getFirstTimestamp());
            const end = await videoInput.computeDuration([track]);
            if (!Number.isFinite(end) || end <= start) throw new Error("journey_film_video_unsupported");
            const sink = new CanvasSink(track, { width, height, fit: "contain", poolSize: 2 });
            function* timestamps() {
              for (let f = shot.startFrame; f < shot.endFrame; f++) yield Math.min(start + (f - shot.startFrame) / fps, Math.max(start, end - 1 / fps));
            }
            videoFrames = sink.canvasesAtTimestamps(timestamps());
          }
        }
      }
      signal.throwIfAborted();
      ctx.globalAlpha = 1; ctx.fillStyle = BACKGROUND; ctx.fillRect(0, 0, width, height);
      if (scene.kind === "media") {
        if (picture) contain(ctx, picture, picture.width, picture.height, width, height);
        else if (videoFrames) {
          const decoded = await videoFrames.next();
          signal.throwIfAborted();
          if (!decoded.value) throw new Error("journey_film_video_unsupported");
          ctx.drawImage(decoded.value.canvas, 0, 0, width, height);
        }
        if (opening && state.openingOpacity > 0) {
          ctx.save(); ctx.globalAlpha = state.openingOpacity;
          contain(ctx, opening, opening.width, opening.height, width, height); ctx.restore();
        }
      } else {
        ctx.textAlign = "left"; ctx.textBaseline = "top";
        ctx.fillStyle = ACCENT; ctx.font = `${fontSize * 0.72}px ${FONT}`;
        ctx.fillText("STARTRIPS  /  JOURNEY", margin, margin);
        ctx.fillStyle = INK; ctx.font = `500 ${fontSize * 1.65}px ${FONT}`;
        const heading = scene.role === "arrival" ? journey.routePoints[pointIndex.get(scene.routePointId) ?? -1]?.label || journey.title : journey.title;
        wrapText(ctx, heading, width - margin * 2).forEach((line, i) => ctx.fillText(line, margin, margin + fontSize * (2 + i * 2)));
        const box = Math.min(width - 2 * margin, height * 0.45);
        const xy = points.map((p) => ({ x: (width - box) / 2 + p.x * box, y: height * 0.32 + p.y * box }));
        ctx.strokeStyle = "#657079"; ctx.lineWidth = Math.max(2, width * 0.003); ctx.setLineDash([6, 8]);
        ctx.beginPath(); xy.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)); ctx.stroke(); ctx.setLineDash([]);
        xy.forEach((p, index) => {
          if (!journey.routePoints[index].isStop) return;
          ctx.fillStyle = ACCENT; ctx.beginPath(); ctx.arc(p.x, p.y, Math.max(4, width * 0.006), 0, 2 * Math.PI); ctx.fill();
        });
        let cursor: number | null = null;
        if (scene.role === "arrival") cursor = pointIndex.get(scene.routePointId) ?? null;
        if (scene.role === "travel") {
          const from = pointIndex.get(scene.fromRoutePointId), to = pointIndex.get(scene.toRoutePointId);
          if (from !== undefined && to !== undefined) cursor = from + (to - from) * (state.reducedMotion ? 1 : state.sourceProgress);
        }
        if (cursor !== null && xy.length) {
          const a = xy[Math.floor(cursor)], b = xy[Math.min(xy.length - 1, Math.ceil(cursor))];
          if (a && b) { const t = cursor % 1; ctx.fillStyle = INK; ctx.beginPath(); ctx.arc(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, Math.max(7, width * 0.009), 0, 2 * Math.PI); ctx.fill(); }
        }
        ctx.fillStyle = "#9aa6af"; ctx.font = `${fontSize * 0.76}px ${FONT}`;
        ctx.fillText("旅程路线示意 · 非道路导航", margin, height - margin - fontSize * 2);
        ctx.fillText(journey.startedOn + (journey.endedOn ? ` — ${journey.endedOn}` : ""), margin, height - margin);
      }
      if (state.captionId) {
        const caption = film.captions.get(state.captionId);
        if (caption === undefined) throw new Error("memory_film_caption_missing");
        drawCaption(caption);
      }
      await source.add(frame / fps, 1 / fps);
      if (frame % 8 === 0) { input.onFrame(frame + 1); await new Promise<void>((resolve) => setTimeout(resolve, 0)); }
    }
    await releaseMedia();
    source.close();
    await output.finalize();
    signal.throwIfAborted();
    if (!target.buffer || target.buffer.byteLength > 96 * 1024 * 1024) throw new Error("journey_film_output_invalid");
    input.onFrame(film.manifest.totalFrames);
    return new Blob([target.buffer], { type: "video/mp4" });
  } finally {
    signal.removeEventListener("abort", abort);
    await releaseMedia();
    opening?.close();
    if (output.state !== "finalized" && output.state !== "canceled") await output.cancel().catch(() => {});
    canvas.width = 1; canvas.height = 1;
  }
}
