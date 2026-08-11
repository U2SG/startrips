export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const ALLOWED_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
]);

export function validatePersonalMomentImage(
  file: Pick<File, "type" | "size">,
): string | null {
  if (!ALLOWED_IMAGE_TYPES.has(file.type)) {
    return "请使用 JPG、PNG 或 WebP 图片";
  }
  if (file.size > MAX_IMAGE_BYTES) {
    return "图片需小于 8 MB";
  }
  return null;
}

export type PreparedPersonalMomentImage = {
  blob: Blob;
  previewUrl: string;
  thumbnailUrl: string;
  originalName: string;
  width: number;
  height: number;
};

export async function preparePersonalMomentImage(
  file: File,
): Promise<PreparedPersonalMomentImage> {
  const validationError = validatePersonalMomentImage(file);
  if (validationError) {
    throw new Error(validationError);
  }

  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { alpha: false });

  if (!context) {
    bitmap.close();
    throw new Error("当前浏览器无法处理这张图片");
  }

  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  const outputType = file.type === "image/png" ? "image/png" : "image/webp";
  const encodeCanvas = (
    target: HTMLCanvasElement,
    type: string,
    quality?: number,
  ) => new Promise<Blob>((resolve, reject) => {
    target.toBlob(
      (result) => result
        ? resolve(result)
        : reject(new Error("图片处理失败，请重试")),
      type,
      quality,
    );
  });
  const blob = await encodeCanvas(
    canvas,
    outputType,
    outputType === "image/png" ? undefined : 0.86,
  );

  const thumbnailScale = Math.min(1, 512 / Math.max(width, height));
  let thumbnailBlob = blob;
  if (thumbnailScale < 1) {
    const thumbnailCanvas = document.createElement("canvas");
    thumbnailCanvas.width = Math.max(1, Math.round(width * thumbnailScale));
    thumbnailCanvas.height = Math.max(1, Math.round(height * thumbnailScale));
    const thumbnailContext = thumbnailCanvas.getContext("2d", { alpha: false });
    if (thumbnailContext) {
      thumbnailContext.drawImage(
        canvas,
        0,
        0,
        thumbnailCanvas.width,
        thumbnailCanvas.height,
      );
      thumbnailBlob = await encodeCanvas(thumbnailCanvas, "image/webp", 0.72);
    }
  }

  const previewUrl = URL.createObjectURL(blob);
  const thumbnailUrl = thumbnailBlob === blob
    ? previewUrl
    : URL.createObjectURL(thumbnailBlob);

  return {
    blob,
    previewUrl,
    thumbnailUrl,
    originalName: file.name,
    width,
    height,
  };
}
