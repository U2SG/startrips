/** #489: identify synthetic media in compositor captures independently of currentSrc.
 * CDP frame swap timestamps pair paint with the existing DOM writer trace.
 * Captures are samples, not a claim about every physical display refresh.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";

const colors = [
  [255, 64, 64], [64, 255, 64], [64, 64, 255], [255, 255, 64],
  [255, 64, 255], [64, 255, 255], [255, 160, 64], [160, 64, 255],
];
const probes = [[0.5, 0.5], [0.3, 0.5], [0.7, 0.5], [0.5, 0.3], [0.5, 0.7]];

export async function createPaintFixtures(directory, execute) {
  const fixtures = { ordinary: [], large: [] };
  for (const [tier, longest] of [["ordinary", 800], ["large", 4096]]) {
    for (const [index, rgb] of colors.entries()) {
      // R3 starts portrait, then browses consecutive landscape images at one point.
      const [width, height] = index === 0 ? [longest * 3 / 4, longest] : [longest, longest * 3 / 4];
      const path = `${directory}/fixtures/paint-${tier}-${index + 1}.png`;
      const hex = rgb.map((value) => value.toString(16).padStart(2, "0")).join("");
      await execute("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i",
        `color=c=0x${hex}:s=${width}x${height},format=rgb24`, "-frames:v", "1", path]);
      fixtures[tier].push({ body: await readFile(path), width, height });
    }
  }
  return fixtures;
}

export async function capturePaint(cdp, page) {
  const timeOrigin = await page.evaluate(() => performance.timeOrigin);
  const frames = [], errors = [], waiters = new Set();
  let bytes = 0;
  const receive = (event) => {
    void cdp.send("Page.screencastFrameAck", { sessionId: event.sessionId }).catch((error) => errors.push(String(error)));
    if (errors.length) return;
    bytes += Buffer.byteLength(event.data, "base64");
    if (frames.length >= 5000 || bytes > 64 * 1024 * 1024) {
      errors.push("Compositor capture exceeded its bounded frame/byte budget");
      return;
    }
    if (!Number.isFinite(event.metadata.timestamp)) {
      errors.push("Compositor frame has no swap timestamp");
      return;
    }
    const frame = { data: event.data, metadata: event.metadata, at: event.metadata.timestamp * 1000 - timeOrigin };
    frames.push(frame);
    for (const waiter of waiters) if (frame.at >= waiter.at) waiter.resolve(frame.at);
  };
  cdp.on("Page.screencastFrame", receive);
  await cdp.send("Page.startScreencast", { format: "png", maxWidth: 540, maxHeight: 610, everyNthFrame: 1 });
  return {
    waitForFrame(at) {
      if (!Number.isFinite(at)) throw new Error("Final settled DOM milestone was not observed");
      if (errors.length) throw new Error(errors.join("; "));
      const delivered = frames.find((frame) => frame.at >= at);
      if (delivered) return Promise.resolve(delivered.at);
      // Delivery, rather than a delay, owns the terminal capture boundary. A
      // missing swap stays invalid instead of accepting only earlier pictures.
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          waiters.delete(waiter);
          reject(new Error("No compositor frame reached the final settled DOM milestone"));
        }, 2_000);
        const waiter = { at, resolve(value) { clearTimeout(timer); waiters.delete(waiter); resolve(value); },
          cancel() { clearTimeout(timer); waiters.delete(waiter); reject(new Error("Compositor capture stopped before its final frame")); } };
        waiters.add(waiter);
      });
    },
    async stop() {
      await cdp.send("Page.stopScreencast");
      cdp.off("Page.screencastFrame", receive);
      for (const waiter of waiters) waiter.cancel();
      return { frames, errors, bytes };
    },
  };
}

function identify(rgb, ids) {
  const matches = colors.map((color, index) => {
    const brightness = rgb.reduce((sum, value, channel) => sum + value * color[channel], 0)
      / color.reduce((sum, value) => sum + value * value, 0);
    const residual = Math.hypot(...rgb.map((value, channel) => value - color[channel] * brightness));
    return { id: ids[index], brightness, residual };
  }).sort((a, b) => a.residual - b.residual);
  return matches[0].brightness > 0.1 && matches[0].residual < 12 ? matches[0] : null;
}

export async function gradePaint(page, capture, observations, ids, directory) {
  await mkdir(directory, { recursive: true });
  if (!Number.isFinite(observations.endedAt)) throw new Error("DOM observation has no terminal capture boundary");
  const dom = [...observations.frames].sort((a, b) => a.at - b.at);
  const shots = [...capture.frames].sort((a, b) => a.at - b.at);
  const samples = [], failures = [], sequences = new Map(), counts = {};
  let cursor = 0, previous = ids[0], requested = ids[0];
  for (let offset = 0; offset < shots.length; offset += 24) {
    const batch = shots.slice(offset, offset + 24).map((shot) => {
      while (cursor + 1 < dom.length && dom[cursor + 1].at <= shot.at) cursor += 1;
      const frame = dom[cursor];
      if (!frame || frame.at > shot.at || shot.at > observations.endedAt) return { ...shot, points: [], outside: true };
      if (frame.requested && frame.requested !== requested) { previous = requested; requested = frame.requested; }
      const points = frame.aperture ? probes.map(([x, y]) => ({
        x: frame.aperture.left + frame.aperture.width * x,
        y: frame.aperture.top + frame.aperture.height * y,
      })) : [];
      return { ...shot, points, requested, previous, domAt: frame.at, domOwner: frame.points[0]?.actual ?? null };
    });
    // Decode captured bytes after the observed run. Reading a DOM image/canvas here
    // would merely repeat its claimed identity and miss a stale compositor layer.
    const pixels = await page.evaluate(async (batch) => {
      const result = [];
      const canvas = document.createElement("canvas");
      canvas.width = 1; canvas.height = 1;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      for (const shot of batch) {
        if (shot.outside) { result.push([]); continue; }
        const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${shot.data}`)).blob());
        try {
          result.push(shot.points.map((point) => {
            const x = Math.floor(point.x * shot.metadata.pageScaleFactor * bitmap.width / shot.metadata.deviceWidth);
            const y = Math.floor((point.y * shot.metadata.pageScaleFactor + shot.metadata.offsetTop) * bitmap.height / shot.metadata.deviceHeight);
            if (x < 0 || y < 0 || x >= bitmap.width || y >= bitmap.height) return null;
            context.clearRect(0, 0, 1, 1);
            context.drawImage(bitmap, x, y, 1, 1, 0, 0, 1, 1);
            return [...context.getImageData(0, 0, 1, 1).data].slice(0, 3);
          }));
        } finally { bitmap.close(); }
      }
      return result;
    }, batch);
    for (const [index, shot] of batch.entries()) {
      if (shot.outside) continue;
      const identities = pixels[index].map((rgb) => rgb && identify(rgb, ids));
      const reasons = [];
      if (!identities.length || identities.some((identity) => !identity)) reasons.push("paint-blank-or-composite");
      if (identities.some((identity) => identity && identity.id !== shot.requested && identity.id !== shot.previous)) reasons.push("paint-third-media-exposure");
      if (identities.some((identity) => identity && identity.brightness < 0.98)) reasons.push("paint-dimmed-picture");
      const actual = identities[0]?.id ?? null;
      const sequence = sequences.get(shot.requested) ?? [];
      if (actual !== sequence.at(-1)) { sequence.push(actual); sequences.set(shot.requested, sequence); }
      const target = sequence.indexOf(shot.requested);
      if (target >= 0 && sequence.slice(target + 1).some((id) => id && id !== shot.requested)) reasons.push("paint-foreground-reversal");
      const path = `${directory}/frame-${String(offset + index).padStart(5, "0")}.png`;
      await writeFile(path, Buffer.from(shot.data, "base64"));
      const sample = { at: shot.at, domAt: shot.domAt, metadata: shot.metadata, requested: shot.requested,
        previous: shot.previous, domOwner: shot.domOwner, pixels: pixels[index], identities, reasons, path };
      samples.push(sample);
      if (reasons.length) { failures.push(sample); for (const reason of reasons) counts[reason] = (counts[reason] ?? 0) + 1; }
    }
  }
  await writeFile(`${directory}/samples.json`, JSON.stringify(samples, null, 2));
  // A missing/misregistered capture cannot claim a pass. Each reached target must
  // also have actual pixel evidence, independently of its settled DOM attributes.
  const observedIds = new Set(samples.map((sample) => sample.identities[0]?.id).filter(Boolean));
  const validExecution = capture.errors.length === 0 && ids.slice(0, 7).every((id) => observedIds.has(id));
  return { frames: samples.length, bytes: capture.bytes, errors: capture.errors, validExecution,
    counts, sequences: Object.fromEntries(sequences), firstFailures: failures.slice(0, 12), reproduced: failures.length > 0 };
}
