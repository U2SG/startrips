export type MediaPreviewSpec = {
  width: number;
  height: number;
  mimeType: string;
  maxBytes: number;
};

export type MediaPreviewSourceDimensions = { width: number; height: number };

export function photoSourceDimensions(
  image: Pick<HTMLImageElement, "naturalWidth" | "naturalHeight">,
): MediaPreviewSourceDimensions {
  return { width: image.naturalWidth, height: image.naturalHeight };
}

export function videoSourceDimensions(
  video: Pick<HTMLVideoElement, "videoWidth" | "videoHeight">,
): MediaPreviewSourceDimensions {
  return { width: video.videoWidth, height: video.videoHeight };
}

/** EXIF 5-8 transpose the stored axes before presentation. */
export function orientedSourceDimensions(
  source: MediaPreviewSourceDimensions,
  orientation: number | null | undefined,
): MediaPreviewSourceDimensions {
  const value = orientation ?? 1;
  return value >= 5 && value <= 8
    ? { width: source.height, height: source.width }
    : { ...source };
}

/**
 * Pure fit used by both photo and video producers. It never exceeds the issued
 * server rectangle and keeps the source aspect ratio; the real server plan is
 * expected to match this rectangle apart from integer rounding.
 */
export function fitMediaPreview(
  source: MediaPreviewSourceDimensions,
  spec: Pick<MediaPreviewSpec, "width" | "height">,
): MediaPreviewSourceDimensions {
  if (source.width <= 0 || source.height <= 0 || spec.width <= 0 || spec.height <= 0) {
    throw new Error("Preview dimensions must be positive");
  }
  const scale = Math.min(spec.width / source.width, spec.height / source.height);
  return {
    width: Math.max(1, Math.min(spec.width, Math.round(source.width * scale))),
    height: Math.max(1, Math.min(spec.height, Math.round(source.height * scale))),
  };
}

export type PreparedMediaPreview = {
  sourceWidth: number;
  sourceHeight: number;
  /** Browser image/video decoders expose presentation-oriented pixels here. */
  exifOrientation: null;
  rasterize(spec: MediaPreviewSpec): Promise<Blob>;
  dispose(): void;
};

function waitForImage(image: HTMLImageElement): Promise<void> {
  return new Promise((resolve, reject) => {
    const loaded = () => resolve();
    const failed = () => reject(new Error("Preview image could not be decoded"));
    image.addEventListener("load", loaded, { once: true });
    image.addEventListener("error", failed, { once: true });
  });
}

function waitForVideo(video: HTMLVideoElement): Promise<void> {
  return new Promise((resolve, reject) => {
    const loaded = () => resolve();
    const failed = () => reject(new Error("Preview video frame could not be decoded"));
    video.addEventListener("loadeddata", loaded, { once: true });
    video.addEventListener("error", failed, { once: true });
  });
}

async function canvasJpegWithinBudget(canvas: HTMLCanvasElement, maxBytes: number): Promise<Blob> {
  for (const quality of [0.82, 0.7, 0.58, 0.46, 0.34, 0.24, 0.16, 0.1]) {
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
    if (blob && blob.size <= maxBytes) return blob;
  }
  throw new Error("Preview JPEG exceeds the issued byte budget");
}

function rasterizer(source: CanvasImageSource) {
  return async (spec: MediaPreviewSpec): Promise<Blob> => {
    if (spec.mimeType !== "image/jpeg") throw new Error("Unsupported preview output type");
    const canvas = document.createElement("canvas");
    canvas.width = spec.width;
    canvas.height = spec.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Preview canvas is unavailable");
    context.drawImage(source, 0, 0, spec.width, spec.height);
    return canvasJpegWithinBudget(canvas, spec.maxBytes);
  };
}

/**
 * Prepare one browser-decoded source. HTML image/video dimensions already
 * describe the presentation orientation the user sees, so the request sends
 * `exifOrientation: null` rather than applying EXIF a second time.
 */
export async function prepareMediaPreview(file: Blob): Promise<PreparedMediaPreview> {
  const objectUrl = URL.createObjectURL(file);
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    URL.revokeObjectURL(objectUrl);
  };
  try {
    if (file.type.startsWith("image/")) {
      const image = new Image();
      image.decoding = "async";
      const loaded = waitForImage(image);
      image.src = objectUrl;
      await loaded;
      const dimensions = photoSourceDimensions(image);
      if (!dimensions.width || !dimensions.height) throw new Error("Preview image has no dimensions");
      return {
        sourceWidth: dimensions.width,
        sourceHeight: dimensions.height,
        exifOrientation: null,
        rasterize: rasterizer(image),
        dispose,
      };
    }
    if (file.type.startsWith("video/")) {
      const video = document.createElement("video");
      video.muted = true;
      video.playsInline = true;
      video.preload = "auto";
      const loaded = waitForVideo(video);
      video.src = objectUrl;
      video.load();
      await loaded;
      const dimensions = videoSourceDimensions(video);
      if (!dimensions.width || !dimensions.height) throw new Error("Preview video has no dimensions");
      return {
        sourceWidth: dimensions.width,
        sourceHeight: dimensions.height,
        exifOrientation: null,
        rasterize: rasterizer(video),
        dispose,
      };
    }
    throw new Error("Media type has no preview producer");
  } catch (error) {
    dispose();
    throw error;
  }
}
