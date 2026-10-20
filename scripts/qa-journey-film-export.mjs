// Real owner Story button -> native dialog -> H.264/AAC MP4 with authorized journey music.
// Synthetic media and HTTP authorization fixtures only; no production account or upload.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { launchQaBrowser, revealStoryViewingOptions } from "./qa-browser.mjs";

const origin = process.env.QA_ORIGIN ?? "http://127.0.0.1:4173";
const outputDir = "artifacts/journey-film-export";
await mkdir(outputDir, { recursive: true });
const ffmpeg = process.env.FFMPEG_PATH ?? (process.platform === "win32" ? "D:/tools/ffmpeg/bin/ffmpeg.exe" : "ffmpeg");
const ffprobe = process.env.FFPROBE_PATH ?? (process.platform === "win32" ? "D:/tools/ffmpeg/bin/ffprobe.exe" : "ffprobe");
const run = (exe, args) => {
  const result = spawnSync(exe, args, { encoding: "utf8", timeout: 30_000, windowsHide: true });
  assert.equal(result.status, 0, `${exe} failed: ${result.error ?? result.stderr}`);
  return result.stdout;
};
const photo = await sharp({ create: { width: 320, height: 480, channels: 3, background: "#426f98" } }).jpeg().toBuffer();
const opening = await sharp({ create: { width: 320, height: 480, channels: 3, background: "#c89a66" } }).jpeg().toBuffer();
const videoPath = path.join(outputDir, "source-video.mp4");
// The clip has its own distinguishable audio; the film must never import it.
run(ffmpeg, ["-y", "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=12:duration=1",
  "-f", "lavfi", "-i", "sine=frequency=880:sample_rate=48000:duration=1",
  "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", videoPath]);
const video = await readFile(videoPath);
// A short stereo musical interval must loop to cover the much longer film.
const soundtrackSeconds = 2;
const soundtrackPath = path.join(outputDir, "source-soundtrack.wav");
run(ffmpeg, ["-y", "-f", "lavfi", "-i",
  `aevalsrc=0.12*sin(2*PI*440*t)|0.10*sin(2*PI*660*t):s=48000:d=${soundtrackSeconds}`,
  "-c:a", "pcm_s16le", soundtrackPath]);
const soundtrack = await readFile(soundtrackPath);
const media = new Map([["photo", photo], ["clip", video], ["soundtrack", soundtrack]]);
const mimeType = (id) => id === "soundtrack" ? "audio/wav" : id === "clip" ? "video/mp4" : "image/jpeg";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const fixture = {
  id: "journey-film-qa", atlasId: "atlas-qa", title: "Paris Trip 海风", startedOn: "2026-10-01", endedOn: "2026-10-02",
  note: "", lightColor: "#d8bf91", coverMediaAssetId: "photo", revision: 1,
  createdByUserId: "qa-owner", createdAt: "2026-10-01", updatedAt: "2026-10-01",
  routePoints: [0, 1].map((index) => ({ id: `p${index}`, journeyId: "journey-film-qa", sortOrder: index,
    latitude: 22.3 + index * 0.2, longitude: 114 + index * 0.2,
    label: index ? "海边" : "出发", isStop: true, note: index ? "海风很轻，慢慢走。" : null,
    occurredAt: null, createdAt: "2026-10-01" })),
  media: [...media].map(([id, bytes], index) => ({ id, journeyId: "journey-film-qa", routePointId: id === "soundtrack" ? null : `p${index}`,
    mimeType: mimeType(id), fileName: `${id}.${id === "soundtrack" ? "wav" : id === "clip" ? "mp4" : "jpg"}`, bytes: bytes.length,
    sortOrder: index, contentHash: hash(bytes), contentHashVerified: true, createdAt: "2026-10-01" })),
};
// A noted shape-only via has no arrival scene. Its full 640-character note
// makes this real owner export exceed two minutes without extra source media.
const shortViaNote = "途中的海风，也值得记下。";
const longViaNote = "沿着海边慢慢走。".repeat(80);
assert.equal(longViaNote.length, 640);
fixture.routePoints.splice(1, 0, {
  ...fixture.routePoints[0], id: "p-via", label: "途中", isStop: false,
  latitude: 22.4, longitude: 114.1, note: longViaNote, sortOrder: 1,
});
fixture.routePoints.forEach((point, index) => { point.sortOrder = index; });
const harnessPath = path.join(outputDir, "harness.tsx");
await writeFile(harnessPath, `import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { JourneyStory } from "/src/journey/JourneyStory";
import { exportPrivateJourneyFilm } from "/src/journey/journeyFilmExport";
import { createOwnerAtlasView, AtlasViewProvider, GUEST_ATLAS_VIEW_CAPABILITIES } from "/src/journey/atlasView";
// Match the production shell: absolute media tools need their positioned
// media container and shared tokens, rather than the bare QA viewport.
import "/src/styles/tokens.css";
import "/src/styles/controls.css";
import "/src/app.css";
import "/src/styles/living-atlas.css";
import "/src/styles/starlight-experience.css";
import "/src/styles/story-experience.css";
function Harness(){
 const [journey,setJourney]=useState(window.__filmFixture);
 window.__filmSetJourney=setJourney;
 const owner=createOwnerAtlasView();
 const normalExport=owner.exportJourneyFilm;
 owner.exportJourneyFilm=(id,options)=>{
  if(!window.__filmHoldCleanup) return normalExport(id,options).then(artifact=>{
   window.__filmLastStorageMode=artifact.storageMode;
   return artifact;
  });
  let entered=false;
  // A deferred encoder is used only for the remount/lifetime case below.
  // All earlier MP4/pixel checks still use the real encoder.
  return exportPrivateJourneyFilm(id,options,{encode:async({signal})=>{
   signal.throwIfAborted(); entered=true;
   window.__filmEncoderStarts=(window.__filmEncoderStarts||0)+1;
   return new Promise((resolve,reject)=>{
    const abort=()=>{
     window.__filmAwaitingCleanup=true;
     window.__filmReleaseCleanup=()=>{
      signal.removeEventListener("abort",abort);
      window.__filmAwaitingCleanup=false;
      reject(signal.reason);
     };
    };
    signal.addEventListener("abort",abort,{once:true});
   });
  }}).finally(()=>{if(entered) window.__filmSettledEncoders=(window.__filmSettledEncoders||0)+1;});
 };
 const guest={capabilities:GUEST_ATLAS_VIEW_CAPABILITIES,mutations:null,readMedia:owner.readMedia,listJourneys:async()=>[journey],listHomeBasePeriods:null,listHomeBaseDismissals:null};
 return <AtlasViewProvider value={window.__filmGuest ? guest : owner}><div className="living-atlas"><JourneyStory
 journeys={[journey]} journeyId={journey.id} onClose={()=>{}} onNavigate={()=>{}} onMediaAdded={async()=>journey}
 onEdit={window.__filmGuest ? undefined : ()=>{}} /></div></AtlasViewProvider>
}
createRoot(document.getElementById("root")).render(<Harness/>);`);
const browser = await launchQaBrowser();
const evidence = { checks: [], files: [], screenshots: [], filenames: [] };
const heldReads = new Set();
let stage = "start";
const mark = (value) => { stage = value; console.log("QA_STAGE", value); };
// The first real encode now contains over 3,600 full-resolution frames.
const watchdog = setTimeout(() => { console.error("QA_TIMEOUT", stage); process.exit(1); }, 300_000);
try {
  const context = await browser.newContext({ viewport: { width: 1365, height: 1000 }, acceptDownloads: true });
  let current = structuredClone(fixture);
  let revoked = false;
  let delayed = false;
  let blockedResolve;
  const blockedRead = new Promise((resolve) => { blockedResolve = resolve; });
  let exportReads = 0;
  let soundtrackSigns = 0, soundtrackReads = 0;
  const expiresAt = () => new Date(Date.now() + 600_000).toISOString();
  await context.route("**/__film_qa", (route) => route.fulfill({ contentType: "text/html", body:
    `<!doctype html><meta charset="utf-8"><style>body{margin:0;background:#101820;color:#eee;font-family:Arial,sans-serif}</style><div id="root"></div><script type="module" src="/${harnessPath.replaceAll("\\", "/")}"></script>` }));
  await context.route(`${origin}/api/**`, (route) => {
    const url = new URL(route.request().url());
    if (revoked) return route.fulfill({ status: 401, json: { error: "AUTH_REQUIRED" } });
    if (url.pathname === `/api/journeys/${fixture.id}`) return route.fulfill({ json: { journey: current } });
    if (url.pathname === "/api/journeys") return route.fulfill({ json: { journeys: [current] } });
    if (url.pathname === "/api/cover-reveal/recipes") return route.fulfill({ json: { recipes: [
      { id: "ink-wash-memory", title: "水墨记忆" }, { id: "poetic-line-memory", title: "线条记忆" }, { id: "paper-collage-memory", title: "纸上记忆" },
    ] } });
    if (url.pathname.endsWith("/status")) return route.fulfill({ json: { state: "ready", recipeId: "paper-collage-memory", sourceMediaAssetId: "photo", derivativeId: "opening-qa" } });
    if (url.pathname.startsWith("/api/cover-reveal/")) return route.fulfill({ json: {
      derivative: { id: "opening-qa", journeyId: fixture.id, sourceMediaAssetId: "photo", sourceContentHash: fixture.media[0].contentHash,
        generationKind: "paper-collage-memory", generationVersion: 1, presetId: "guided-ribbon", mimeType: "image/jpeg", width: 320, height: 480 },
      display: { url: "https://film-storage.invalid/opening", expiresAt: expiresAt() },
    } });
    const match = /\/api\/uploads\/assets\/([^/]+)\/read-url/.exec(url.pathname);
    if (match) {
      if (match[1] === "soundtrack") soundtrackSigns++;
      return route.fulfill({ json: { url: `https://film-storage.invalid/${match[1]}`, expiresAt: expiresAt() } });
    }
    return route.fulfill({ json: {} });
  });
  await context.route("https://film-storage.invalid/**", async (route) => {
    const id = new URL(route.request().url()).pathname.slice(1);
    exportReads++;
    if (id === "soundtrack" && route.request().resourceType() === "fetch") soundtrackReads++;
    if (delayed && route.request().resourceType() === "fetch") {
      let release;
      const pending = new Promise((resolve) => { release = resolve; });
      heldReads.add(release); blockedResolve();
      await pending; heldReads.delete(release);
    }
    const bytes = id === "opening" ? opening : media.get(id);
    await route.fulfill({ body: bytes, contentType: mimeType(id),
      headers: { "access-control-allow-origin": "*" } }).catch(() => {});
  });
  await context.addInitScript((trip) => {
    window.__filmFixture = trip;
    // Exercise the real anchor-download fallback; native save-picker semantics have separate unit coverage.
    Object.defineProperty(window, "showSaveFilePicker", { configurable: true, value: undefined });
  }, fixture);
  const page = await context.newPage();
  const retainedDownloads = () => page.evaluate(async () => {
    const { listRetainedJourneyFilmDownloads } = await import("/src/journey/journeyFilmStorage.ts");
    return listRetainedJourneyFilmDownloads();
  });
  page.setDefaultTimeout(20_000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") console.log("BROWSER_CONSOLE", message.text()); });
  await page.goto(`${origin}/__film_qa`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "编辑故事", exact: true }).click().catch(async (error) => {
    await writeFile(`${outputDir}/failure.html`, await page.content());
    await page.screenshot({ path: `${outputDir}/failure.png` });
    console.log("PAGE_ERRORS", JSON.stringify(errors));
    console.log("BODY", (await page.locator("body").innerText()).slice(0, 5000));
    throw error;
  });
  await page.getByRole("button", { name: "导出短片", exact: true }).click();
  let dialog = page.getByRole("dialog", { name: "导出旅程短片", exact: true });
  await dialog.waitFor({ state: "visible" });
  const duration = dialog.getByLabel("基础时长（非上限）", { exact: true });
  const durationHint = "完整导出全部场景和已启用字幕，不按 60 秒截断；实际时长随内容增加。";
  assert.deepEqual(await duration.locator("option").evaluateAll((options) => options.map((option) => ({ value: option.value, text: option.textContent }))), [
    { value: "15", text: "15 秒基准" }, { value: "30", text: "30 秒基准" }, { value: "60", text: "60 秒基准" },
  ]);
  assert.equal(await duration.inputValue(), "30");
  assert.equal(await duration.getAttribute("aria-describedby"), "journey-film-duration-hint");
  assert.equal(await dialog.locator("#journey-film-duration-hint").innerText(), durationHint);
  assert.equal(await dialog.getByText(durationHint, { exact: true }).isVisible(), true);
  evidence.checks.push("duration presets are explicitly baselines, with accessible non-cap guidance");
  assert.equal(await dialog.getByLabel("包含途径点感想字幕").isChecked(), false);
  assert.equal(await dialog.getByLabel("包含旅程配乐").isChecked(), true);
  await dialog.getByLabel("基础时长（非上限）", { exact: true }).selectOption("15");
  await dialog.getByLabel("包含途径点感想字幕").check();
  await page.screenshot({ path: `${outputDir}/desktop-settings.png` });
  evidence.screenshots.push(`${outputDir}/desktop-settings.png`);
  const signsBeforeExport = soundtrackSigns, readsBeforeExport = soundtrackReads;
  mark("complete portrait film beyond two minutes with looping soundtrack");
  await dialog.getByRole("button", { name: "生成 MP4", exact: true }).click();
  await dialog.getByRole("button", { name: "下载 MP4", exact: true }).waitFor({ state: "visible", timeout: 240_000 });
  assert.equal(await page.evaluate(() => window.__filmLastStorageMode), "disk",
    "the real long export must use bounded disk staging");
  await page.screenshot({ path: `${outputDir}/desktop-ready.png` });
  evidence.screenshots.push(`${outputDir}/desktop-ready.png`);
  const downloadEvent = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "下载 MP4", exact: true }).click();
  const download = await downloadEvent;
  assert.equal(download.suggestedFilename(), "Startrips-Paris Trip 海风.mp4");
  const artifact = `${outputDir}/journey-film.mp4`;
  await download.saveAs(artifact);
  const retainedPortrait = await retainedDownloads();
  assert.equal(retainedPortrait.count, 1);
  assert(retainedPortrait.bytes > 0, "the downloaded disk artifact must remain retained until explicit cleanup");
  evidence.filenames.push({ aspect: "portrait", title: fixture.title, suggested: download.suggestedFilename() });
  const probe = JSON.parse(run(ffprobe, ["-v", "error", "-count_frames", "-show_streams", "-show_format", "-of", "json", artifact]));
  const stream = probe.streams.find((item) => item.codec_type === "video");
  assert.equal(stream.codec_name, "h264"); assert.equal(stream.width, 1080); assert.equal(stream.height, 1920);
  assert.equal(stream.avg_frame_rate, "30/1");
  assert(Number(probe.format.duration) > 120 && Number(probe.format.duration) < 160,
    "the complete film must retain the long via note beyond the former two-minute cutoff");
  assert(Number(stream.nb_read_frames) > 3600);
  const audioStreams = probe.streams.filter((item) => item.codec_type === "audio");
  assert.equal(audioStreams.length, 1);
  const audioStream = audioStreams[0];
  assert.equal(audioStream.codec_name, "aac");
  assert.equal(Number(audioStream.sample_rate), 48000);
  assert.equal(audioStream.channels, 2);
  assert(soundtrackSigns > signsBeforeExport && soundtrackReads > readsBeforeExport,
    "export must obtain a fresh owner-signed soundtrack read");
  const videoDuration = Number(stream.nb_read_frames) / 30;
  const audioDuration = Number(audioStream.duration);
  assert(Number.isFinite(audioDuration) && audioDuration >= videoDuration - 0.05 && audioDuration <= videoDuration + 0.1,
    `AAC duration ${audioDuration}s must cover exactly the ${videoDuration}s film within codec padding`);
  // Decode the MP4 audio itself before and after the short source's loop point.
  // Metadata or a nonempty audio stream alone must not satisfy this check.
  const audioWindows = [];
  for (const start of [0.25, soundtrackSeconds + 0.25, videoDuration - 0.75]) {
    const pcmPath = `${outputDir}/decoded-soundtrack-${start.toFixed(2)}.f32le`;
    run(ffmpeg, ["-y", "-i", artifact, "-ss", String(start), "-t", "0.4", "-map", "0:a:0",
      "-ac", "2", "-ar", "48000", "-c:a", "pcm_f32le", "-f", "f32le", pcmPath]);
    const pcm = await readFile(pcmPath);
    assert(pcm.length >= 48000 * 0.35 * 2 * 4, "decoded audio window must contain real samples");
    const squares = [0, 0], counts = [0, 0];
    for (let offset = 0, sample = 0; offset + 4 <= pcm.length; offset += 4, sample++) {
      const value = pcm.readFloatLE(offset);
      assert(Number.isFinite(value));
      squares[sample % 2] += value * value; counts[sample % 2]++;
    }
    const rms = squares.map((sum, channel) => Math.sqrt(sum / counts[channel]));
    assert(rms.every((value) => value > 0.01), `soundtrack must be audible in both channels at ${start}s: ${rms}`);
    audioWindows.push({ start, seconds: pcm.length / (48000 * 2 * 4), rms });
  }
  evidence.soundtrack = { codec: audioStream.codec_name, sampleRate: Number(audioStream.sample_rate), channels: audioStream.channels,
    sourceSeconds: soundtrackSeconds, audioSeconds: audioDuration, videoSeconds: videoDuration, decodedWindows: audioWindows };
  evidence.checks.push("real owner Story button -> MP4 download", "H.264 1080x1920 30fps, actual duration and decoded frames",
    "complete owner film exceeds two minutes without splitting or omitting captions",
    "notes opt-in and journey soundtrack default-on", "owner-signed AAC stereo 48kHz soundtrack covers the film",
    "decoded nonzero stereo RMS before and after looping and near film end");
  evidence.files.push({ path: artifact, bytes: Number(probe.format.size), duration: Number(probe.format.duration), frames: Number(stream.nb_read_frames) });
  assert.equal(retainedPortrait.bytes, Number(probe.format.size));
  // Inspect decoded movie frames, not a mocked draw callback or a .mp4 extension.
  const framePins = await page.evaluate(async (trip) => {
    const { buildKeepsakeRenderManifest } = await import("/src/journey/journeyKeepsake.ts");
    const { buildKeepsakePrivateRenderPlan } = await import("/src/journey/keepsakePrivateRender.ts");
    const { buildMemoryFilm } = await import("/src/journey/keepsakeMemoryFilm.ts");
    const plan = buildKeepsakePrivateRenderPlan(buildKeepsakeRenderManifest(trip, 15, "portrait"));
    const film = buildMemoryFilm(plan, { journeyId: trip.id, journeyRevision: trip.revision, narrativeSnapshot: plan.narrativeSnapshot,
      routePoints: trip.routePoints.map((point) => ({ routePointId: point.id, latitude: point.latitude, longitude: point.longitude, label: point.label, note: point.note })) },
      { includeRoutePointNotes: true }, { derivativeId: "opening-qa", sourceMediaAssetId: "photo", recipeId: "paper-collage-memory", recipeVersion: 1 });
    const shot = film.manifest.shots.find((item) => item.openingDerivativeId);
    const cues = film.manifest.shots.flatMap((item) => item.captionCues);
    const caption = cues.find((cue) => film.captions.get(cue.id) === trip.routePoints.find((point) => point.id === "p1").note);
    const viaNote = trip.routePoints.find((point) => point.id === "p-via").note;
    const via = cues.find((cue) => film.captions.get(cue.id) === viaNote.slice(0, 64));
    if (!caption || !via) throw new Error("owner export omitted an enabled Route Point note");
    const viaShot = film.manifest.shots.find((item) => item.captionCues.some((cue) => cue.id === via.id));
    const viaPages = viaShot.captionCues.map((cue) => film.captions.get(cue.id)).join("");
    if (viaPages !== viaNote) throw new Error("owner export truncated a long Route Point note");
    const lastVia = viaShot.captionCues.at(-1);
    if (plan.scenes.some(({ scene }) => scene.kind === "map" && scene.role === "arrival" && scene.routePointId === "p-via")) {
      throw new Error("the via must not become a Stop just to show its note");
    }
    return { opening: shot.startFrame, original: shot.endFrame - 1, caption: caption.startFrame + 2,
      viaCaption: via.startFrame + 2, viaFinalCaption: lastVia.endFrame - 2, totalFrames: film.manifest.totalFrames };
  }, fixture);
  assert.equal(Number(stream.nb_read_frames), framePins.totalFrames);
  for (const [name, frame] of Object.entries(framePins).filter(([name]) => name !== "totalFrames")) {
    const filename = `${outputDir}/${name}-frame.png`;
    run(ffmpeg, ["-y", "-i", artifact, "-vf", `select=eq(n\\,${frame})`, "-frames:v", "1", filename]);
    if (name === "opening" || name === "original") {
      const { data, info } = await sharp(filename).removeAlpha().raw().toBuffer({ resolveWithObject: true });
      const offset = (Math.floor(info.height / 2) * info.width + Math.floor(info.width / 2)) * info.channels;
      const expected = name === "opening" ? [200, 154, 102] : [66, 111, 152];
      expected.forEach((channel, index) => assert(Math.abs(data[offset + index] - channel) < 18, `${name} frame must show the correct source image`));
    }
    evidence.screenshots.push(filename);
  }
  evidence.checks.push("decoded creative opening and unchanged original final pixels", "Stop and non-Stop via Chinese-caption frames retained without adding an arrival");
  // A second real encoding exercises landscape and Reduced Motion through the same owner control.
  mark("landscape reduced-motion encode with Unicode filename boundary");
  const boundaryTitle = "A".repeat(76) + "-\u0344😀";
  assert.equal(boundaryTitle.length, 80);
  assert.equal(boundaryTitle.normalize("NFC").length, 81);
  current = { ...current, title: boundaryTitle,
    routePoints: current.routePoints.map((point) => point.id === "p-via" ? { ...point, note: shortViaNote } : point) };
  await page.evaluate((trip) => window.__filmSetJourney(trip), current);
  await dialog.waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "导出短片", exact: true }).click();
  assert.deepEqual(await retainedDownloads(), retainedPortrait, "closing and reopening the dialog must not delete a browser download's backing file");
  await dialog.getByRole("button", { name: "所有下载已完成，清理临时文件", exact: true }).click();
  await dialog.getByRole("status").filter({ hasText: "已清理导出临时文件。" }).waitFor();
  assert.deepEqual(await retainedDownloads(), { count: 0, bytes: 0 });
  evidence.checks.push("long film uses bounded private disk staging", "download backing file survives dialog remount until explicit completed-download cleanup");
  await dialog.getByLabel("基础时长（非上限）", { exact: true }).selectOption("15");
  await dialog.getByLabel("包含途径点感想字幕").check();
  await dialog.getByLabel("包含旅程配乐").uncheck();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await dialog.getByLabel("画面比例").selectOption("landscape");
  await dialog.getByRole("button", { name: "生成 MP4", exact: true }).click();
  await dialog.getByRole("button", { name: "下载 MP4", exact: true }).waitFor({ state: "visible", timeout: 120_000 });
  const landscapeDownloadEvent = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "下载 MP4", exact: true }).click();
  const landscapeArtifact = `${outputDir}/journey-film-landscape.mp4`;
  const landscapeDownload = await landscapeDownloadEvent;
  assert.equal(landscapeDownload.suggestedFilename(), `Startrips-${"A".repeat(76)}-\u0308\u0301.mp4`);
  await landscapeDownload.saveAs(landscapeArtifact);
  evidence.filenames.push({ aspect: "landscape", title: boundaryTitle, normalizedUnits: boundaryTitle.normalize("NFC").length, suggested: landscapeDownload.suggestedFilename() });
  evidence.checks.push("portrait download preserves mixed-case ASCII and Chinese", "landscape native filename is well formed after NFC expands a valid 80-unit title");
  const landscapeProbe = JSON.parse(run(ffprobe, ["-v", "error", "-count_frames", "-show_streams", "-of", "json", landscapeArtifact]));
  const landscapeStream = landscapeProbe.streams.find((item) => item.codec_type === "video");
  assert.equal(landscapeStream.width, 1920); assert.equal(landscapeStream.height, 1080);
  assert.equal(landscapeStream.codec_name, "h264"); assert.equal(landscapeStream.avg_frame_rate, "30/1");
  assert.equal(landscapeProbe.streams.filter((item) => item.codec_type === "audio").length, 0,
    "soundtrack opt-out must remain silent even when a source video contains AAC");
  const landscapePins = await page.evaluate(async (trip) => {
    const { buildKeepsakeRenderManifest } = await import("/src/journey/journeyKeepsake.ts");
    const { buildKeepsakePrivateRenderPlan } = await import("/src/journey/keepsakePrivateRender.ts");
    const { buildMemoryFilm } = await import("/src/journey/keepsakeMemoryFilm.ts");
    const plan = buildKeepsakePrivateRenderPlan(buildKeepsakeRenderManifest(trip, 15, "landscape"));
    const film = buildMemoryFilm(plan, { journeyId: trip.id, journeyRevision: trip.revision, narrativeSnapshot: plan.narrativeSnapshot,
      routePoints: trip.routePoints.map((point) => ({ routePointId: point.id, latitude: point.latitude, longitude: point.longitude, label: point.label, note: point.note })) },
      { includeRoutePointNotes: true, reducedMotion: true });
    const index = plan.scenes.findIndex(({ scene }) => scene.kind === "media" && scene.mediaAssetId === "photo");
    return { original: film.manifest.shots[index].startFrame, totalFrames: film.manifest.totalFrames };
  }, current);
  assert.equal(Number(landscapeStream.nb_read_frames), landscapePins.totalFrames);
  const reducedFrame = `${outputDir}/reduced-motion-original.png`;
  run(ffmpeg, ["-y", "-i", landscapeArtifact, "-vf", `select=eq(n\\,${landscapePins.original})`, "-frames:v", "1", reducedFrame]);
  const reduced = await sharp(reducedFrame).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const middle = (Math.floor(reduced.info.height / 2) * reduced.info.width + Math.floor(reduced.info.width / 2)) * reduced.info.channels;
  [66, 111, 152].forEach((channel, index) => assert(Math.abs(reduced.data[middle + index] - channel) < 18));
  evidence.checks.push("landscape 1920x1080 real MP4", "Reduced Motion skips generated opening pixels",
    "soundtrack opt-out exports no audio and never imports source-video AAC");
  evidence.files.push({ path: landscapeArtifact }); evidence.screenshots.push(reducedFrame);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  // Re-authorization on the explicit second click: an old artifact cannot bypass expired access.
  mark("revoked download");
  revoked = true;
  await dialog.getByRole("button", { name: "下载 MP4", exact: true }).click();
  await dialog.getByRole("alert").waitFor();
  assert.equal(await dialog.getByRole("button", { name: "下载 MP4", exact: true }).count(), 0);
  evidence.checks.push("revoked authorization blocks later download");
  revoked = false;
  mark("close and restore focus");
  await dialog.getByRole("button", { name: "关闭短片导出", exact: true }).click();
  assert.equal(await page.getByRole("button", { name: "导出短片", exact: true }).evaluate((el) => document.activeElement === el), true);
  // Cancel while fetching and release the late response. Neither a ready artifact nor download may appear.
  await page.getByRole("button", { name: "导出短片", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "导出旅程短片", exact: true });
  mark("cancel blocked source");
  delayed = true;
  await dialog.getByRole("button", { name: "生成 MP4", exact: true }).click();
  await Promise.race([blockedRead, new Promise((_, reject) => setTimeout(() => reject(new Error("blocked source fetch was never reached")), 20_000))]);
  await dialog.getByRole("button", { name: "取消导出", exact: true }).click();
  delayed = false; for (const release of heldReads) release(); heldReads.clear();
  await dialog.getByText("已取消导出。", { exact: true }).waitFor();
  assert.equal(await dialog.getByRole("button", { name: "下载 MP4", exact: true }).count(), 0);
  evidence.checks.push("cancellation never publishes a late artifact");
  mark("Escape");
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "导出短片", exact: true }).waitFor({ state: "visible" });
  // A changed Journey invalidates the mounted export panel in the very next render.
  await page.getByRole("button", { name: "导出短片", exact: true }).click();
  mark("changed Journey");
  await page.evaluate((trip) => window.__filmSetJourney({ ...trip, revision: trip.revision + 1 }), fixture);
  await dialog.waitFor({ state: "hidden" });
  evidence.checks.push("Journey revision change closes and invalidates export scope");
  // Phone-sized settings, no overflow; owner-client omission in a guest mount.
  mark("phone settings");
  await page.setViewportSize({ width: 390, height: 844 });
  // Resolve the product's compact layout before choosing its actual entry path;
  // an immediate visibility snapshot can still observe the previous desktop.
  await page.waitForFunction(() => document.querySelector('.journey-story')?.getAttribute('data-story-layout') === 'mobile');
  const phoneButton = page.getByRole("button", { name: "导出短片", exact: true });
  if (await page.locator('.journey-story').getAttribute('data-mobile-mode') !== 'manage') {
    await revealStoryViewingOptions(page);
    await page.getByRole("button", { name: "管理旅程", exact: true }).click();
  }
  await phoneButton.waitFor({ state: "visible" });
  {
    await phoneButton.click();
    await dialog.waitFor({ state: "visible" });
    const box = await dialog.boundingBox(); assert(box && box.x >= 0 && box.width <= 390);
    assert.equal(await dialog.getByText(durationHint, { exact: true }).isVisible(), true);
    assert.equal(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth), true,
      "phone settings must not overflow horizontally with the baseline label");
    const durationBox = await duration.boundingBox();
    assert(durationBox && durationBox.x >= box.x && durationBox.x + durationBox.width <= box.x + box.width,
      "phone duration selector must fit inside the dialog");
    await page.screenshot({ path: `${outputDir}/phone-settings.png` });
    evidence.screenshots.push(`${outputDir}/phone-settings.png`);
    await dialog.getByRole("button", { name: "关闭短片导出", exact: true }).click();
  }
  evidence.checks.push("phone export control and settings are required, not skipped");
  mark("close and reopen before encoder teardown");
  await page.evaluate(() => {
    window.__filmHoldCleanup = true;
    window.__filmEncoderStarts = 0;
    window.__filmSettledEncoders = 0;
    window.__filmAwaitingCleanup = false;
  });
  await page.getByRole("button", { name: "导出短片", exact: true }).click();
  await dialog.getByRole("button", { name: "生成 MP4", exact: true }).click();
  await page.waitForFunction(() => window.__filmEncoderStarts === 1);
  await dialog.getByRole("button", { name: "关闭短片导出", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  await page.waitForFunction(() => window.__filmAwaitingCleanup === true);
  await page.getByRole("button", { name: "导出短片", exact: true }).click();
  await dialog.getByRole("button", { name: "生成 MP4", exact: true }).click();
  await dialog.getByRole("alert").filter({ hasText: "上一段短片仍在生成或清理" }).waitFor();
  assert.equal(await page.evaluate(() => window.__filmEncoderStarts), 1, "a remount must not start a second encoder while old disposal is pending");
  assert.equal(await page.evaluate(() => window.__filmSettledEncoders), 0);
  await page.evaluate(() => window.__filmReleaseCleanup());
  await page.waitForFunction(() => window.__filmSettledEncoders === 1);
  await dialog.getByRole("button", { name: "重新生成", exact: true }).click();
  await page.waitForFunction(() => window.__filmEncoderStarts === 2);
  await dialog.getByRole("button", { name: "关闭短片导出", exact: true }).click();
  await page.waitForFunction(() => window.__filmAwaitingCleanup === true);
  await page.evaluate(() => window.__filmReleaseCleanup());
  await page.waitForFunction(() => window.__filmSettledEncoders === 2);
  await page.evaluate(() => { window.__filmHoldCleanup = false; });
  evidence.checks.push("dialog unmount/remount retains old run ownership through delayed disposal", "explicit retry becomes available only after old exporter settles");
  mark("oversized note guidance and caption opt-out recovery");
  const previousSnapshot = current;
  current = structuredClone(fixture);
  current.media = current.media.filter((asset) => !asset.mimeType.startsWith("audio/"));
  const oversizedNote = "🌍".repeat(4000) + "长"; // 8001 UTF-16 code units, not 8001 code points
  current.routePoints.find((point) => point.id === "p-via").note = oversizedNote;
  await page.getByRole("button", { name: "导出短片", exact: true }).click();
  await dialog.getByLabel("基础时长（非上限）", { exact: true }).selectOption("15");
  assert.equal(await dialog.getByLabel("包含旅程配乐").isChecked(), true);
  await dialog.getByLabel("包含途径点感想字幕").check();
  await dialog.getByRole("button", { name: "生成 MP4", exact: true }).click();
  const lengthAlert = dialog.getByRole("alert").filter({ hasText: "单条感想超过字幕长度上限" });
  await lengthAlert.waitFor();
  assert.equal(await lengthAlert.innerText(), "单条感想超过字幕长度上限，请缩短感想或关闭感想字幕后重试。");
  assert.equal(await dialog.getByRole("button", { name: "下载 MP4", exact: true }).count(), 0);
  assert.equal(current.routePoints.find((point) => point.id === "p-via").note, oversizedNote);
  await page.screenshot({ path: `${outputDir}/oversized-note-error.png` });
  evidence.screenshots.push(`${outputDir}/oversized-note-error.png`);
  await dialog.getByLabel("包含途径点感想字幕").uncheck();
  await dialog.getByRole("button", { name: "重新生成", exact: true }).click();
  await dialog.getByRole("button", { name: "下载 MP4", exact: true }).waitFor({ state: "visible", timeout: 120_000 });
  assert.equal(current.routePoints.find((point) => point.id === "p-via").note, oversizedNote);
  await dialog.getByRole("status").filter({ hasText: "此旅程未设置配乐，成片为静音。" }).waitFor();
  const noTrackDownloadEvent = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "下载 MP4", exact: true }).click();
  const noTrackArtifact = `${outputDir}/journey-film-no-soundtrack.mp4`;
  await (await noTrackDownloadEvent).saveAs(noTrackArtifact);
  const noTrackProbe = JSON.parse(run(ffprobe, ["-v", "error", "-show_streams", "-of", "json", noTrackArtifact]));
  assert.equal(noTrackProbe.streams.filter((item) => item.codec_type === "audio").length, 0);
  assert.equal(noTrackProbe.streams.find((item) => item.codec_type === "video").codec_name, "h264");
  evidence.files.push({ path: noTrackArtifact });
  await dialog.getByRole("button", { name: "所有下载已完成，清理临时文件", exact: true }).click();
  await dialog.getByRole("status").filter({ hasText: "已清理导出临时文件。" }).waitFor();
  assert.deepEqual(await retainedDownloads(), { count: 0, bytes: 0 });
  await dialog.getByRole("button", { name: "关闭短片导出", exact: true }).click();
  current = previousSnapshot;
  evidence.checks.push("oversized UTF-16 note shows shorten-note/disable-caption guidance", "caption opt-out recovers to a real encoded MP4 without modifying the note",
    "no-track journey explicitly reports silence and produces no audio stream even with inclusion checked");
  mark("guest");
  await context.addInitScript(() => { window.__filmGuest = true; });
  await page.reload({ waitUntil: "networkidle" });
  assert.equal(await page.getByRole("button", { name: "导出短片", exact: true }).count(), 0);
  evidence.checks.push("guest view has no export control");
  assert.deepEqual(errors, []);
  assert(exportReads > 0);
  await writeFile(`${outputDir}/evidence.json`, JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  for (const release of heldReads) release(); heldReads.clear();
  console.log("QA_FINAL_STAGE", stage);
  await browser.close();
  clearTimeout(watchdog);
  await rm(harnessPath, { force: true });
}

