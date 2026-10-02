/**
 * #393 Journey Book: a still frame for a video that has no server poster.
 *
 * Pages never hold a `<video>`, so a video page needs a picture of its own.
 * A detached, muted element decodes one early frame and is released at once;
 * it never plays and is never attached to the document.
 *
 * Preferred result is an image URL, because PageFlip copies the turning page
 * in portrait and a copied `<canvas>` loses its pixels. That needs the storage
 * origin to allow CORS; when it does not, the frame is still returned as a
 * canvas, which shows correctly everywhere except on that brief copy.
 */
export type VideoStill =
  | { kind: "image"; url: string }
  | { kind: "canvas"; canvas: HTMLCanvasElement };

const STILL_TIME_SECONDS = 0.1;
const STILL_MAX_EDGE = 960;
const STILL_TIMEOUT_MS = 10_000;

/**
 * iOS shows nothing for a `preload="metadata"` video until it plays; a media
 * fragment makes it decode and present the frame at that time. The fragment
 * is client-side only and never reaches the signed URL's server.
 */
export function withStillFragment(url: string): string {
  return url.includes("#") ? url : `${url}#t=${STILL_TIME_SECONDS}`;
}

function drawFrame(video: HTMLVideoElement): HTMLCanvasElement | null {
  if (video.readyState < 2 || !video.videoWidth || !video.videoHeight) return null;
  const scale = Math.min(1, STILL_MAX_EDGE / Math.max(video.videoWidth, video.videoHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
  canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
  const context = canvas.getContext("2d");
  if (!context) return null;
  try {
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
  } catch {
    return null;
  }
  return canvas;
}

function decodeFrame(url: string, crossOrigin: boolean, signal: AbortSignal): Promise<HTMLCanvasElement | null> {
  return new Promise((resolve) => {
    const video = document.createElement("video");
    let settled = false;
    const finish = (canvas: HTMLCanvasElement | null) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      video.removeAttribute("src");
      video.load();
      resolve(canvas);
    };
    const abort = () => finish(null);
    const timer = window.setTimeout(() => finish(null), STILL_TIMEOUT_MS);
    signal.addEventListener("abort", abort);
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    if (crossOrigin) video.crossOrigin = "anonymous";
    video.addEventListener("error", () => finish(null), { once: true });
    video.addEventListener("loadeddata", () => {
      const frame = drawFrame(video);
      if (frame) {
        finish(frame);
        return;
      }
      video.addEventListener("seeked", () => finish(drawFrame(video)), { once: true });
      video.currentTime = STILL_TIME_SECONDS;
    }, { once: true });
    video.src = withStillFragment(url);
  });
}

export async function captureVideoStill(url: string, signal: AbortSignal): Promise<VideoStill | null> {
  const shared = await decodeFrame(url, true, signal);
  if (shared) {
    try {
      return { kind: "image", url: shared.toDataURL("image/jpeg", 0.82) };
    } catch {
      return { kind: "canvas", canvas: shared };
    }
  }
  if (signal.aborted) return null;
  const local = await decodeFrame(url, false, signal);
  return local ? { kind: "canvas", canvas: local } : null;
}
