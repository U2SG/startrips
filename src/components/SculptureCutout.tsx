import { useEffect, useRef, useState } from "react";

interface SculptureCutoutProps {
  src: string;
  alt: string;
  className?: string;
}

function colorDistance(data: Uint8ClampedArray, offset: number, background: [number, number, number]) {
  const red = data[offset] - background[0];
  const green = data[offset + 1] - background[1];
  const blue = data[offset + 2] - background[2];
  return Math.sqrt(red * red + green * green + blue * blue);
}

function sampleBorder(data: Uint8ClampedArray, width: number, height: number): [number, number, number] {
  let red = 0;
  let green = 0;
  let blue = 0;
  let count = 0;
  const take = (x: number, y: number) => {
    const offset = (y * width + x) * 4;
    red += data[offset];
    green += data[offset + 1];
    blue += data[offset + 2];
    count += 1;
  };

  const step = Math.max(1, Math.floor(Math.min(width, height) / 160));
  for (let x = 0; x < width; x += step) {
    take(x, 0);
    take(x, height - 1);
  }
  for (let y = step; y < height - step; y += step) {
    take(0, y);
    take(width - 1, y);
  }

  return [red / count, green / count, blue / count];
}

function removeConnectedBackground(image: ImageData, width: number, height: number) {
  const { data } = image;
  const background = sampleBorder(data, width, height);
  const visited = new Uint8Array(width * height);
  const queue = new Int32Array(width * height);
  let head = 0;
  let tail = 0;

  const enqueue = (index: number) => {
    if (visited[index]) return;
    const distance = colorDistance(data, index * 4, background);
    if (distance > 62) return;
    visited[index] = 1;
    queue[tail] = index;
    tail += 1;
  };

  for (let x = 0; x < width; x += 1) {
    enqueue(x);
    enqueue((height - 1) * width + x);
  }
  for (let y = 1; y < height - 1; y += 1) {
    enqueue(y * width);
    enqueue(y * width + width - 1);
  }

  while (head < tail) {
    const index = queue[head];
    head += 1;
    const x = index % width;
    const y = Math.floor(index / width);
    if (x > 0) enqueue(index - 1);
    if (x < width - 1) enqueue(index + 1);
    if (y > 0) enqueue(index - width);
    if (y < height - 1) enqueue(index + width);
  }

  for (let index = 0; index < visited.length; index += 1) {
    if (!visited[index]) continue;
    const offset = index * 4;
    const distance = colorDistance(data, offset, background);
    const feather = Math.max(0, Math.min(1, (distance - 18) / 36));
    data[offset + 3] = Math.round(data[offset + 3] * feather);
  }

  return tail > 0 && tail < width * height * 0.92;
}

export function SculptureCutout({ src, alt, className }: SculptureCutoutProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    const image = new Image();
    image.decoding = "async";
    image.onload = () => {
      if (cancelled || !canvasRef.current) return;
      try {
        const scale = Math.min(1, 640 / image.naturalWidth, 640 / image.naturalHeight);
        const width = Math.max(1, Math.round(image.naturalWidth * scale));
        const height = Math.max(1, Math.round(image.naturalHeight * scale));
        const canvas = canvasRef.current;
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext("2d", { willReadFrequently: true });
        if (!context) throw new Error("Canvas is unavailable");
        context.drawImage(image, 0, 0, width, height);
        const pixels = context.getImageData(0, 0, width, height);
        if (!removeConnectedBackground(pixels, width, height)) {
          throw new Error("Background removal was rejected");
        }
        context.putImageData(pixels, 0, 0);
        if (!cancelled) setStatus("ready");
      } catch {
        if (!cancelled) setStatus("error");
      }
    };
    image.onerror = () => {
      if (!cancelled) setStatus("error");
    };
    image.src = src;
    return () => {
      cancelled = true;
      image.onload = null;
      image.onerror = null;
    };
  }, [src]);

  if (status === "error") {
    return <img className={className} src={src} alt={alt} />;
  }

  return (
    <canvas
      ref={canvasRef}
      className={className}
      role="img"
      aria-label={alt}
      aria-busy={status === "loading"}
      data-cutout-status={status}
    />
  );
}
