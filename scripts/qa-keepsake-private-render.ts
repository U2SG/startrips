import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { buildKeepsakeRenderManifest } from "../src/journey/journeyKeepsake";
import {
  buildKeepsakePrivateRenderPlan,
  resolveKeepsakePrivateJourneyContext,
  resolveKeepsakePrivateMedia,
  type AuthorizedKeepsakeMedia,
  type AuthorizedKeepsakeMediaRequest,
  type AuthorizedKeepsakeMediaResolver,
  type KeepsakePrivateRenderPlan,
  type KeepsakePrivateRenderScene,
} from "../src/journey/keepsakePrivateRender";
import type { Journey, JourneyMediaAsset, RoutePoint } from "../src/journey/types";

const PROTOTYPE_WIDTH = 360;
const PROTOTYPE_HEIGHT = 640;
const PROTOTYPE_FPS = 12;
const ARTIFACT_DIR = resolve("artifacts/keepsake-render");

// Fixture-only presentation coordinates/labels. Production rendering must resolve
// canonical spatial context for the exact journeyId + journeyRevision instead.
const ROUTE_POINTS = [
  { x: 72, y: 500, label: "HONG KONG" },
  { x: 180, y: 352, label: "TAIPEI" },
  { x: 288, y: 190, label: "TOKYO" },
] as const;

const GLYPHS: Record<string, readonly string[]> = {
  " ": ["000", "000", "000", "000", "000", "000", "000"],
  "-": ["00000", "00000", "00000", "11111", "00000", "00000", "00000"],
  "0": ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
  "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
  "2": ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
  "3": ["11110", "00001", "00001", "01110", "00001", "00001", "11110"],
  A: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
  D: ["11110", "10001", "10001", "10001", "10001", "10001", "11110"],
  E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  G: ["01110", "10001", "10000", "10111", "10001", "10001", "01110"],
  H: ["10001", "10001", "10001", "11111", "10001", "10001", "10001"],
  I: ["11111", "00100", "00100", "00100", "00100", "00100", "11111"],
  K: ["10001", "10010", "10100", "11000", "10100", "10010", "10001"],
  L: ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
  M: ["10001", "11011", "10101", "10101", "10001", "10001", "10001"],
  N: ["10001", "11001", "10101", "10011", "10001", "10001", "10001"],
  O: ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  P: ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
  R: ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
  S: ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
  T: ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
  V: ["10001", "10001", "10001", "10001", "10001", "01010", "00100"],
  Y: ["10001", "10001", "01010", "00100", "00100", "00100", "00100"],
};

interface RenderMetrics {
  wallTimeMs: number;
  maxRssKb: number | null;
  bytes: number;
  sha256: string;
}

function routePoint(id: string, sortOrder: number, latitude: number, longitude: number): RoutePoint {
  return {
    id,
    journeyId: "journey-keepsake-prototype",
    sortOrder,
    latitude,
    longitude,
    label: ROUTE_POINTS[sortOrder]?.label ?? `STOP ${sortOrder + 1}`,
    isStop: true,
    occurredAt: `2026-08-${String(10 + sortOrder).padStart(2, "0")}T08:00:00.000Z`,
    note: sortOrder === 1 ? "Harbor light and a slow evening." : null,
    createdAt: "2026-08-10T00:00:00.000Z",
  };
}

function media(
  id: string,
  routePointId: string | null,
  mimeType: string,
  sortOrder: number,
): JourneyMediaAsset {
  return {
    id,
    journeyId: "journey-keepsake-prototype",
    routePointId,
    storageDriver: "s3",
    storageKey: `private-prototype/${id}`,
    fileName: `${id}.${mimeType.startsWith("video/") ? "mp4" : "jpg"}`,
    mimeType,
    bytes: 2048,
    sortOrder,
    uploadedByUserId: "fixture-owner",
    createdAt: "2026-08-10T00:00:00.000Z",
  };
}

function fixtureJourney(): Journey {
  return {
    id: "journey-keepsake-prototype",
    atlasId: "atlas-private-prototype",
    title: "Pacific lights",
    startedOn: "2026-08-10",
    endedOn: "2026-08-12",
    note: "",
    lightColor: "#f4ce73",
    revision: 4,
    createdByUserId: "fixture-owner",
    createdAt: "2026-08-10T00:00:00.000Z",
    updatedAt: "2026-08-12T00:00:00.000Z",
    routePoints: [
      routePoint("rp-hkg", 0, 22.3193, 114.1694),
      routePoint("rp-tpe", 1, 25.033, 121.5654),
      routePoint("rp-tyo", 2, 35.6762, 139.6503),
    ],
    media: [
      media("opening-photo", null, "image/jpeg", 0),
      media("hkg-photo", "rp-hkg", "image/jpeg", 0),
      media("tpe-video", "rp-tpe", "video/mp4", 0),
      media("tyo-photo", "rp-tyo", "image/jpeg", 0),
    ],
  };
}

class SyntheticPrivateMediaVault implements AuthorizedKeepsakeMediaResolver {
  readonly #payloads = new Map<string, AuthorizedKeepsakeMedia>([
    ["opening-photo", {
      mediaAssetId: "opening-photo",
      mimeType: "image/jpeg",
      bytes: new TextEncoder().encode("private-fixture:opening:amber-night"),
    }],
    ["hkg-photo", {
      mediaAssetId: "hkg-photo",
      mimeType: "image/jpeg",
      bytes: new TextEncoder().encode("private-fixture:hkg:harbor-reflection"),
    }],
    ["tpe-video", {
      mediaAssetId: "tpe-video",
      mimeType: "video/mp4",
      bytes: new TextEncoder().encode("private-fixture:tpe:lantern-motion-frame-seed"),
    }],
    ["tyo-photo", {
      mediaAssetId: "tyo-photo",
      mimeType: "image/jpeg",
      bytes: new TextEncoder().encode("private-fixture:tyo:blue-hour-crossing"),
    }],
  ]);

  async resolveAuthorizedMedia(request: AuthorizedKeepsakeMediaRequest): Promise<AuthorizedKeepsakeMedia> {
    const media = this.#payloads.get(request.mediaAssetId);
    if (!media) throw new Error(`keepsake_fixture_media_not_authorized:${request.mediaAssetId}`);
    return {
      mediaAssetId: media.mediaAssetId,
      mimeType: media.mimeType,
      bytes: new Uint8Array(media.bytes),
    };
  }
}

function sha256(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

function setPixel(buffer: Buffer, x: number, y: number, r: number, g: number, b: number): void {
  if (x < 0 || y < 0 || x >= PROTOTYPE_WIDTH || y >= PROTOTYPE_HEIGHT) return;
  const offset = (Math.floor(y) * PROTOTYPE_WIDTH + Math.floor(x)) * 3;
  buffer[offset] = Math.max(0, Math.min(255, Math.round(r)));
  buffer[offset + 1] = Math.max(0, Math.min(255, Math.round(g)));
  buffer[offset + 2] = Math.max(0, Math.min(255, Math.round(b)));
}

function fill(buffer: Buffer, r: number, g: number, b: number): void {
  for (let offset = 0; offset < buffer.length; offset += 3) {
    const y = Math.floor(offset / 3 / PROTOTYPE_WIDTH);
    const lift = Math.round((1 - y / PROTOTYPE_HEIGHT) * 14);
    buffer[offset] = Math.min(255, r + lift);
    buffer[offset + 1] = Math.min(255, g + lift);
    buffer[offset + 2] = Math.min(255, b + lift);
  }
}

function rect(
  buffer: Buffer,
  x: number,
  y: number,
  width: number,
  height: number,
  color: readonly [number, number, number],
): void {
  for (let yy = y; yy < y + height; yy += 1) {
    for (let xx = x; xx < x + width; xx += 1) setPixel(buffer, xx, yy, ...color);
  }
}

function circle(
  buffer: Buffer,
  cx: number,
  cy: number,
  radius: number,
  color: readonly [number, number, number],
): void {
  const radiusSquared = radius * radius;
  for (let y = cy - radius; y <= cy + radius; y += 1) {
    for (let x = cx - radius; x <= cx + radius; x += 1) {
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy <= radiusSquared) setPixel(buffer, x, y, ...color);
    }
  }
}

function line(
  buffer: Buffer,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  color: readonly [number, number, number],
  thickness = 2,
): void {
  const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
  for (let step = 0; step <= steps; step += 1) {
    const t = steps === 0 ? 0 : step / steps;
    const x = Math.round(x0 + (x1 - x0) * t);
    const y = Math.round(y0 + (y1 - y0) * t);
    circle(buffer, x, y, thickness, color);
  }
}

function drawText(
  buffer: Buffer,
  text: string,
  x: number,
  y: number,
  scale: number,
  color: readonly [number, number, number],
): void {
  let cursorX = x;
  for (const char of text.toUpperCase()) {
    const glyph = GLYPHS[char] ?? ["111", "101", "001", "010", "010", "000", "010"];
    const glyphWidth = glyph[0]?.length ?? 3;
    for (let row = 0; row < glyph.length; row += 1) {
      for (let column = 0; column < glyphWidth; column += 1) {
        if (glyph[row]?.[column] !== "1") continue;
        rect(buffer, cursorX + column * scale, y + row * scale, scale, scale, color);
      }
    }
    cursorX += (glyphWidth + 1) * scale;
  }
}

function seededParticles(buffer: Buffer, seed: number, color: readonly [number, number, number]): void {
  let state = seed >>> 0;
  for (let index = 0; index < 82; index += 1) {
    state = (state * 1664525 + 1013904223) >>> 0;
    const x = 20 + (state % (PROTOTYPE_WIDTH - 40));
    state = (state * 1664525 + 1013904223) >>> 0;
    const y = 70 + (state % (PROTOTYPE_HEIGHT - 150));
    const radius = 1 + (state % 2);
    circle(buffer, x, y, radius, color);
  }
}

function mapProgress(entry: KeepsakePrivateRenderScene): number {
  const scene = entry.scene;
  if (scene.kind !== "map") return -1;
  if (scene.role === "intro") return -1;
  if (scene.role === "outro") return ROUTE_POINTS.length - 1;
  return scene.pointIndex;
}

function frameForMap(entry: KeepsakePrivateRenderScene): Buffer {
  const buffer = Buffer.alloc(PROTOTYPE_WIDTH * PROTOTYPE_HEIGHT * 3);
  fill(buffer, 6, 13, 23);
  seededParticles(buffer, entry.index + 11, [28, 70, 92]);
  drawText(buffer, "STARTRIPS", 24, 30, 3, [231, 238, 235]);
  const scene = entry.scene;
  const role = scene.kind === "map" ? scene.role.toUpperCase() : "MAP";
  drawText(buffer, role === "ARRIVAL" ? "ARRIVAL" : role, 24, 62, 2, [126, 172, 187]);

  const progress = mapProgress(entry);
  for (let index = 0; index < ROUTE_POINTS.length - 1; index += 1) {
    const from = ROUTE_POINTS[index];
    const to = ROUTE_POINTS[index + 1];
    const active = progress >= index + 1;
    line(buffer, from.x, from.y, to.x, to.y, active ? [221, 194, 113] : [50, 77, 88], active ? 2 : 1);
  }
  for (let index = 0; index < ROUTE_POINTS.length; index += 1) {
    const point = ROUTE_POINTS[index];
    const active = progress >= index;
    circle(buffer, point.x, point.y, active ? 7 : 4, active ? [240, 214, 133] : [62, 89, 100]);
    drawText(buffer, point.label, Math.max(12, point.x - 44), point.y + 14, 1, active ? [224, 229, 222] : [91, 113, 120]);
  }
  return buffer;
}

function frameForMedia(
  entry: KeepsakePrivateRenderScene,
  media: AuthorizedKeepsakeMedia,
): Buffer {
  const buffer = Buffer.alloc(PROTOTYPE_WIDTH * PROTOTYPE_HEIGHT * 3);
  const digest = createHash("sha256").update(media.bytes).digest();
  const base: [number, number, number] = [
    26 + (digest[0] % 50),
    34 + (digest[1] % 58),
    45 + (digest[2] % 72),
  ];
  fill(buffer, ...base);
  seededParticles(buffer, digest.readUInt32BE(0), [110, 137, 145]);
  rect(buffer, 24, 108, 312, 410, [Math.min(255, base[0] + 22), Math.min(255, base[1] + 20), Math.min(255, base[2] + 18)]);
  for (let index = 0; index < 12; index += 1) {
    const x = 42 + ((digest[index] * 7 + index * 31) % 270);
    const y = 135 + ((digest[(index + 7) % digest.length] * 5 + index * 43) % 340);
    circle(buffer, x, y, 5 + (digest[index] % 13), [
      90 + (digest[(index + 1) % digest.length] % 120),
      90 + (digest[(index + 2) % digest.length] % 120),
      90 + (digest[(index + 3) % digest.length] % 120),
    ]);
  }

  drawText(buffer, "STARTRIPS", 24, 30, 3, [241, 241, 232]);
  const scene = entry.scene;
  if (scene.kind === "media") {
    const mediaKind = scene.mediaType === "video" ? "VIDEO" : "MEDIA";
    drawText(buffer, mediaKind, 24, 62, 2, [226, 204, 139]);
    const pointLabel = scene.pointIndex === null
      ? "INTRO"
      : ROUTE_POINTS[scene.pointIndex]?.label ?? `STOP ${scene.pointIndex + 1}`;
    drawText(buffer, pointLabel, 36, 540, 2, [239, 239, 230]);
  }
  return buffer;
}

async function writePpm(filePath: string, pixels: Buffer): Promise<void> {
  const header = Buffer.from(`P6\n${PROTOTYPE_WIDTH} ${PROTOTYPE_HEIGHT}\n255\n`, "ascii");
  await writeFile(filePath, Buffer.concat([header, pixels]));
}

function concatPath(filePath: string): string {
  return filePath.replaceAll("\\", "/").replaceAll("'", "'\\''");
}

async function commandExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function run(command: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", rejectPromise);
    child.once("close", (code) => {
      if (code === 0) resolvePromise({ stdout, stderr });
      else rejectPromise(new Error(`${command} exited ${code}: ${stderr || stdout}`));
    });
  });
}

async function runBuffer(command: string, args: string[]): Promise<{ stdout: Buffer; stderr: string }> {
  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdoutChunks: Buffer[] = [];
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdoutChunks.push(Buffer.from(chunk)); });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", rejectPromise);
    child.once("close", (code) => {
      if (code === 0) resolvePromise({ stdout: Buffer.concat(stdoutChunks), stderr });
      else rejectPromise(new Error(`${command} exited ${code}: ${stderr}`));
    });
  });
}

async function encode(
  concatFile: string,
  outputFile: string,
  timeFile: string,
): Promise<RenderMetrics> {
  const ffmpegArgs = [
    "-hide_banner",
    "-loglevel", "error",
    "-f", "concat",
    "-safe", "0",
    "-i", concatFile,
    "-vf", `fps=${PROTOTYPE_FPS},format=yuv420p`,
    "-c:v", "libx264",
    "-preset", "medium",
    "-crf", "20",
    "-pix_fmt", "yuv420p",
    "-threads", "1",
    "-map_metadata", "-1",
    "-metadata", "creation_time=1970-01-01T00:00:00Z",
    "-fflags", "+bitexact",
    "-flags:v", "+bitexact",
    "-movflags", "+faststart",
    "-y",
    outputFile,
  ];

  const startedAt = performance.now();
  let maxRssKb: number | null = null;
  if (await commandExists("/usr/bin/time")) {
    await run("/usr/bin/time", ["-f", "MAX_RSS_KB=%M", "-o", timeFile, "ffmpeg", ...ffmpegArgs]);
    const timeOutput = await readFile(timeFile, "utf8");
    const match = /MAX_RSS_KB=(\d+)/.exec(timeOutput);
    maxRssKb = match ? Number(match[1]) : null;
  } else {
    await run("ffmpeg", ffmpegArgs);
  }
  const wallTimeMs = Math.round(performance.now() - startedAt);
  const bytes = (await stat(outputFile)).size;
  const outputBytes = await readFile(outputFile);
  return { wallTimeMs, maxRssKb, bytes, sha256: sha256(outputBytes) };
}

async function frameMd5(filePath: string): Promise<string> {
  const result = await run("ffmpeg", [
    "-hide_banner",
    "-loglevel", "error",
    "-i", filePath,
    "-map", "0:v:0",
    "-f", "framemd5",
    "-",
  ]);
  return result.stdout.trim();
}

async function probe(filePath: string): Promise<Record<string, unknown>> {
  const result = await run("ffprobe", [
    "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", "stream=codec_name,width,height,pix_fmt,avg_frame_rate,nb_frames,duration",
    "-of", "json",
    filePath,
  ]);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

type TransitionScheduleEntry = { scene: string; startFrame: number; endFrame: number };

type DecodedTransitionProof = {
  scene: string;
  expectedStartFrame: number;
  actualStartFrame: number;
  expectedEndFrame: number;
  actualEndFrame: number;
  decodedSceneMarker: number;
};

function validatePrototypeOutput(
  mediaProbe: Record<string, unknown>,
  plan: KeepsakePrivateRenderPlan,
): TransitionScheduleEntry[] {
  const streams = mediaProbe.streams;
  if (!Array.isArray(streams) || streams.length !== 1 || typeof streams[0] !== "object" || streams[0] === null) {
    throw new Error("keepsake_render_probe_stream_missing");
  }
  const stream = streams[0] as Record<string, unknown>;
  const expectedFrameCount = Math.round((plan.actualDurationMs * PROTOTYPE_FPS) / 1000);
  const expectedDurationSeconds = expectedFrameCount / PROTOTYPE_FPS;
  if (
    stream.codec_name !== "h264"
    || stream.width !== PROTOTYPE_WIDTH
    || stream.height !== PROTOTYPE_HEIGHT
    || stream.pix_fmt !== "yuv420p"
    || stream.avg_frame_rate !== `${PROTOTYPE_FPS}/1`
    || Number(stream.nb_frames) !== expectedFrameCount
    || Math.abs(Number(stream.duration) - expectedDurationSeconds) > (1 / PROTOTYPE_FPS / 10)
  ) {
    throw new Error("keepsake_render_probe_semantics_mismatch");
  }

  let expectedStartMs = 0;
  const transitionSchedule = plan.scenes.map((entry) => {
    if (entry.startMs !== expectedStartMs || entry.endMs !== entry.startMs + entry.scene.durationMs) {
      throw new Error("keepsake_render_transition_schedule_mismatch");
    }
    expectedStartMs = entry.endMs;
    return {
      scene: sceneLabel(entry),
      startFrame: Math.round((entry.startMs * PROTOTYPE_FPS) / 1000),
      endFrame: Math.round((entry.endMs * PROTOTYPE_FPS) / 1000),
    };
  });
  if (
    expectedStartMs !== plan.actualDurationMs
    || transitionSchedule.at(-1)?.endFrame !== expectedFrameCount
  ) {
    throw new Error("keepsake_render_transition_schedule_mismatch");
  }
  return transitionSchedule;
}

const SCENE_MARKER_CELL_SIZE = 8;
const SCENE_MARKER_COLUMNS = 4;
const SCENE_MARKER_ROWS = 4;
const SCENE_MARKER_X = 8;
const SCENE_MARKER_Y = PROTOTYPE_HEIGHT - (SCENE_MARKER_ROWS * SCENE_MARKER_CELL_SIZE) - 8;
const SCENE_MARKER_WIDTH = SCENE_MARKER_COLUMNS * SCENE_MARKER_CELL_SIZE;
const SCENE_MARKER_HEIGHT = SCENE_MARKER_ROWS * SCENE_MARKER_CELL_SIZE;

function stampSceneMarker(buffer: Buffer, sceneIndex: number): number {
  const marker = sceneIndex + 1;
  if (marker > 0xffff) throw new Error("keepsake_render_scene_marker_overflow");
  for (let bit = 0; bit < SCENE_MARKER_COLUMNS * SCENE_MARKER_ROWS; bit += 1) {
    const value = (marker & (1 << bit)) === 0 ? 32 : 224;
    const column = bit % SCENE_MARKER_COLUMNS;
    const row = Math.floor(bit / SCENE_MARKER_COLUMNS);
    rect(
      buffer,
      SCENE_MARKER_X + column * SCENE_MARKER_CELL_SIZE,
      SCENE_MARKER_Y + row * SCENE_MARKER_CELL_SIZE,
      SCENE_MARKER_CELL_SIZE,
      SCENE_MARKER_CELL_SIZE,
      [value, value, value],
    );
  }
  return marker;
}

function decodeSceneMarkerPatch(buffer: Buffer): number {
  const expectedBytes = SCENE_MARKER_WIDTH * SCENE_MARKER_HEIGHT * 3;
  if (buffer.byteLength !== expectedBytes) {
    throw new Error("keepsake_render_decoded_transition_frame_size_mismatch");
  }
  let marker = 0;
  for (let bit = 0; bit < SCENE_MARKER_COLUMNS * SCENE_MARKER_ROWS; bit += 1) {
    const column = bit % SCENE_MARKER_COLUMNS;
    const row = Math.floor(bit / SCENE_MARKER_COLUMNS);
    const startX = column * SCENE_MARKER_CELL_SIZE + 2;
    const startY = row * SCENE_MARKER_CELL_SIZE + 2;
    let sum = 0;
    let samples = 0;
    for (let y = startY; y < startY + SCENE_MARKER_CELL_SIZE - 4; y += 1) {
      for (let x = startX; x < startX + SCENE_MARKER_CELL_SIZE - 4; x += 1) {
        const offset = (y * SCENE_MARKER_WIDTH + x) * 3;
        sum += buffer[offset] + buffer[offset + 1] + buffer[offset + 2];
        samples += 3;
      }
    }
    if (sum / samples >= 128) marker |= (1 << bit);
  }
  return marker;
}

async function decodedSceneMarkers(filePath: string, expectedFrameCount: number): Promise<number[]> {
  const result = await runBuffer("ffmpeg", [
    "-hide_banner",
    "-loglevel", "error",
    "-i", filePath,
    "-map", "0:v:0",
    "-vf", `crop=${SCENE_MARKER_WIDTH}:${SCENE_MARKER_HEIGHT}:${SCENE_MARKER_X}:${SCENE_MARKER_Y},format=rgb24`,
    "-vsync", "0",
    "-f", "rawvideo",
    "-",
  ]);
  const bytesPerFrame = SCENE_MARKER_WIDTH * SCENE_MARKER_HEIGHT * 3;
  if (result.stdout.byteLength !== expectedFrameCount * bytesPerFrame) {
    throw new Error("keepsake_render_decoded_transition_frame_count_mismatch");
  }
  return Array.from({ length: expectedFrameCount }, (_value, frameIndex) => {
    const start = frameIndex * bytesPerFrame;
    return decodeSceneMarkerPatch(result.stdout.subarray(start, start + bytesPerFrame));
  });
}

function validateDecodedTransitions(
  decodedMarkers: readonly number[],
  schedule: readonly TransitionScheduleEntry[],
  expectedSceneMarkers: readonly number[],
): DecodedTransitionProof[] {
  if (schedule.length !== expectedSceneMarkers.length) {
    throw new Error("keepsake_render_decoded_transition_scene_count_mismatch");
  }
  const expectedFrameCount = schedule.at(-1)?.endFrame ?? 0;
  if (decodedMarkers.length !== expectedFrameCount) {
    throw new Error("keepsake_render_decoded_transition_frame_count_mismatch");
  }

  const runs: Array<{ marker: number; startFrame: number; endFrame: number }> = [];
  for (let frameIndex = 0; frameIndex < decodedMarkers.length; frameIndex += 1) {
    const marker = decodedMarkers[frameIndex];
    const previous = runs.at(-1);
    if (!previous || previous.marker !== marker) {
      runs.push({ marker, startFrame: frameIndex, endFrame: frameIndex + 1 });
    } else {
      previous.endFrame = frameIndex + 1;
    }
  }
  if (runs.length !== schedule.length) {
    throw new Error("keepsake_render_decoded_transition_scene_count_mismatch");
  }

  return schedule.map((entry, sceneIndex) => {
    const run = runs[sceneIndex];
    const expectedMarker = expectedSceneMarkers[sceneIndex];
    if (run.marker !== expectedMarker) {
      throw new Error("keepsake_render_decoded_transition_scene_mismatch");
    }
    // The concat demuxer timestamps still-image packets on its own time base,
    // while the fps filter emits a 12 fps CFR stream. One-frame quantization at
    // an interior boundary is therefore acceptable; anything larger means the
    // encoded scene timing no longer matches the semantic render schedule.
    const startTolerance = sceneIndex === 0 ? 0 : 1;
    const endTolerance = sceneIndex === schedule.length - 1 ? 0 : 1;
    if (
      Math.abs(run.startFrame - entry.startFrame) > startTolerance
      || Math.abs(run.endFrame - entry.endFrame) > endTolerance
    ) {
      throw new Error("keepsake_render_decoded_transition_boundary_mismatch");
    }
    return {
      scene: entry.scene,
      expectedStartFrame: entry.startFrame,
      actualStartFrame: run.startFrame,
      expectedEndFrame: entry.endFrame,
      actualEndFrame: run.endFrame,
      decodedSceneMarker: run.marker,
    };
  });
}

function sceneLabel(entry: KeepsakePrivateRenderScene): string {
  const scene = entry.scene;
  if (scene.kind === "media") return `media:${scene.mediaAssetId}`;
  if (scene.role === "arrival") return `arrival:${scene.routePointId}`;
  if (scene.role === "travel") return `travel:${scene.fromRoutePointId}->${scene.toRoutePointId}`;
  return `map:${scene.role}`;
}

async function buildFrames(
  workDir: string,
  plan: KeepsakePrivateRenderPlan,
  resolvedMedia: Map<string, AuthorizedKeepsakeMedia>,
): Promise<{ concatFile: string; sceneMarkers: number[] }> {
  const lines: string[] = [];
  const sceneMarkers: number[] = [];
  for (const entry of plan.scenes) {
    const scene = entry.scene;
    const pixels = scene.kind === "media"
      ? frameForMedia(entry, resolvedMedia.get(scene.mediaAssetId)!)
      : frameForMap(entry);
    sceneMarkers.push(stampSceneMarker(pixels, entry.index));
    const framePath = join(workDir, `scene-${String(entry.index).padStart(3, "0")}.ppm`);
    await writePpm(framePath, pixels);
    lines.push(`file '${concatPath(framePath)}'`);
    lines.push(`duration ${(scene.durationMs / 1000).toFixed(3)}`);
  }
  const lastFrame = join(workDir, `scene-${String(plan.scenes.length - 1).padStart(3, "0")}.ppm`);
  lines.push(`file '${concatPath(lastFrame)}'`);
  const concatFile = join(workDir, "scenes.concat.txt");
  await writeFile(concatFile, `${lines.join("\n")}\n`, "utf8");
  return { concatFile, sceneMarkers };
}

async function main(): Promise<void> {
  await run("ffmpeg", ["-version"]);
  await run("ffprobe", ["-version"]);
  await mkdir(ARTIFACT_DIR, { recursive: true });
  const workDir = join(tmpdir(), `startrips-keepsake-${process.pid}`);
  await rm(workDir, { recursive: true, force: true });
  await mkdir(workDir, { recursive: true });

  try {
    const journey = fixtureJourney();
    const manifest = buildKeepsakeRenderManifest(journey, 15, "portrait");
    const plan = buildKeepsakePrivateRenderPlan(manifest);
    await resolveKeepsakePrivateJourneyContext(plan, {
      resolveAuthorizedJourneyContext: async (journeyId, journeyRevision) => ({
        journeyId,
        journeyRevision,
        narrativeSnapshot: structuredClone(plan.narrativeSnapshot),
        routePoints: journey.routePoints.map((routePoint) => ({
          routePointId: routePoint.id,
          latitude: routePoint.latitude,
          longitude: routePoint.longitude,
          label: routePoint.label ?? null,
          note: routePoint.note ?? null,
        })),
      }),
    });
    const resolvedMedia = await resolveKeepsakePrivateMedia(plan, new SyntheticPrivateMediaVault());
    const { concatFile, sceneMarkers } = await buildFrames(workDir, plan, resolvedMedia);

    const outputA = join(ARTIFACT_DIR, "keepsake-prototype-a.mp4");
    const outputB = join(ARTIFACT_DIR, "keepsake-prototype-b.mp4");
    const firstMetrics = await encode(concatFile, outputA, join(workDir, "time-a.txt"));
    const secondMetrics = await encode(concatFile, outputB, join(workDir, "time-b.txt"));
    const [frameHashA, frameHashB, mediaProbe] = await Promise.all([
      frameMd5(outputA),
      frameMd5(outputB),
      probe(outputA),
    ]);

    if (frameHashA !== frameHashB) {
      throw new Error("keepsake_render_decoded_frame_signature_mismatch");
    }
    const transitionSchedule = validatePrototypeOutput(mediaProbe, plan);
    const expectedFrameCount = transitionSchedule.at(-1)?.endFrame ?? 0;
    const decodedTransitionMarkers = await decodedSceneMarkers(outputA, expectedFrameCount);
    const decodedTransitionProof = validateDecodedTransitions(
      decodedTransitionMarkers,
      transitionSchedule,
      sceneMarkers,
    );

    const metrics = {
      fixture: {
        journeyId: journey.id,
        routePointIds: journey.routePoints.map((point) => point.id),
        mediaAssetIds: plan.mediaAssetIds,
        sceneOrder: plan.scenes.map(sceneLabel),
        transitionSchedule,
        decodedTransitionProof,
        manifestDurationMs: manifest.actualDurationMs,
        requestedOutput: manifest.output,
      },
      prototypeOutput: {
        width: PROTOTYPE_WIDTH,
        height: PROTOTYPE_HEIGHT,
        fps: PROTOTYPE_FPS,
        format: "mp4/h264",
        soundtrack: "none",
        privateMediaResolution: manifest.privacy.mediaResolution,
      },
      firstRender: firstMetrics,
      secondRender: secondMetrics,
      deterministic: {
        decodedFrameSignatureSha256: sha256(frameHashA),
        decodedFramesIdentical: true,
        containerBytesIdentical: firstMetrics.sha256 === secondMetrics.sha256,
      },
      technicalQuality: mediaProbe,
    };

    const metricsPath = join(ARTIFACT_DIR, "metrics.json");
    await writeFile(metricsPath, `${JSON.stringify(metrics, null, 2)}\n`, "utf8");
    const summary = [
      "# Startrips Keepsake private render prototype",
      "",
      `- Fixture: ${journey.routePoints.length} Route Points / ${plan.mediaAssetIds.length} private media assets / ${plan.scenes.length} semantic scenes`,
      `- Encoded output: ${PROTOTYPE_WIDTH}x${PROTOTYPE_HEIGHT} @ ${PROTOTYPE_FPS} fps H.264 MP4`,
      `- Manifest duration: ${manifest.actualDurationMs} ms (15 s preset, non-destructive fit may run long)`,
      `- Render A: ${firstMetrics.wallTimeMs} ms, ${firstMetrics.bytes} bytes, max RSS ${firstMetrics.maxRssKb ?? "unavailable"} KB`,
      `- Render B: ${secondMetrics.wallTimeMs} ms, ${secondMetrics.bytes} bytes, max RSS ${secondMetrics.maxRssKb ?? "unavailable"} KB`,
      `- Decoded frame signature identical: yes (${metrics.deterministic.decodedFrameSignatureSha256})`,
      `- Decoded transition frames verified against source PPM scenes: ${decodedTransitionProof.reduce((sum, proof) => sum + proof.actualEndFrame - proof.actualStartFrame, 0)} frames`,
      `- Container bytes identical: ${metrics.deterministic.containerBytesIdentical ? "yes" : "no (decoded frames remain identical)"}`,
      "- Media acquisition: each private read carries the pinned Journey narrative and must be atomically re-authorized against canonical state; no storage coordinate or share URL enters the serializable render plan",
      "- Spatial presentation: fixture-only ROUTE_POINTS; production requires revision-pinned authorized Journey context",
      `- Scene order: ${metrics.fixture.sceneOrder.join(" | ")}`,
      "",
    ].join("\n");
    await writeFile(join(ARTIFACT_DIR, "summary.md"), summary, "utf8");
    process.stdout.write(summary);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

await main();
