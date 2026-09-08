/**
 * #260: the pixel size of a produced preview, read out of the object itself.
 *
 * The server plans a still and hands a producer a spec, but a plan is not a
 * property of the bytes that arrive. Once `MultipartStorage` can read a whole
 * small object back, the encoded dimensions are measurable, so the pixel
 * ceiling stops being a bound the server asks for and becomes one it verifies
 * before a preview is ever marked ready.
 *
 * Only JPEG is understood, and that is not a limitation: `PREVIEW_MIME_TYPE`
 * is the one format the server chooses, the presigned write binds
 * `content-type` into its signature, and an object that does not parse as a
 * JPEG frame is exactly what this must refuse.
 *
 * The frame header is all that is read. Decoding the entropy-coded scan would
 * mean carrying a codec this deployment deliberately does not have, and the
 * dimensions a viewer will see are in the header by construction — every
 * decoder in the world takes them from the same two fields.
 */

const SOI = 0xd8;
const EOI = 0xd9;
const SOS = 0xda;
/** Restart markers and TEM carry no payload, so they have no length to skip. */
const STANDALONE_MARKERS = new Set([0x01, 0xd0, 0xd1, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7]);

/**
 * SOF0/SOF1/SOF2... — every start-of-frame marker carries the same size
 * fields. `DHT` (0xc4), `JPG` (0xc8) and `DAC` (0xcc) share the range without
 * being frames, which is why they are excluded rather than the range narrowed
 * to baseline: a progressive still is still a still.
 */
function isStartOfFrame(marker: number) {
  return marker >= 0xc0
    && marker <= 0xcf
    && marker !== 0xc4
    && marker !== 0xc8
    && marker !== 0xcc;
}

export type PixelSize = { width: number; height: number };

/**
 * #265: how much of a produced still is read back to measure its frame.
 *
 * Everything `readJpegPixelSize` needs sits in the segments ahead of the first
 * scan, so completion asks storage for a window rather than for the object.
 * 64 KiB is chosen against what actually precedes a frame: one APP segment can
 * carry at most 65,533 bytes, and the pinned 2048x1024 fixture — an ordinary
 * camera JPEG with EXIF, XMP and a 4.5 KB ICC profile in front of its SOF —
 * reaches its frame at byte 4,852. The window is therefore an order of
 * magnitude clear of a realistic header while being a small fraction of the
 * 8 MiB `MEDIA_PREVIEW_MAX_BYTES` may be configured to allow.
 *
 * A still whose frame header does not appear inside the window reads as
 * unmeasurable and is refused, deliberately: the server chose this encoding
 * and asked for a small still, so tens of kilobytes of metadata in front of
 * the frame is not the preview that was planned. The refusal is not a loss of
 * the media — the original reads through the unchanged contract, and a later
 * `POST .../preview` may derive again.
 */
export const JPEG_HEADER_WINDOW_BYTES = 64 * 1024;

/**
 * The encoded pixel size of a JPEG, or `null` if these bytes are not one.
 *
 * `null` covers every way the answer can be absent — truncated bytes, a
 * segment length that walks off the end, a frame declaring a zero dimension,
 * or another format entirely — because the caller treats all of them
 * identically: an object whose size cannot be established is not servable.
 */
export function readJpegPixelSize(bytes: Uint8Array): PixelSize | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== SOI) return null;

  let offset = 2;
  while (offset + 1 < bytes.length) {
    // Segments may be separated by any number of 0xFF fill bytes.
    if (bytes[offset] !== 0xff) return null;
    let marker = bytes[offset + 1];
    let markerAt = offset + 1;
    while (marker === 0xff && markerAt + 1 < bytes.length) {
      markerAt += 1;
      marker = bytes[markerAt];
    }
    if (marker === EOI || marker === SOS) return null;
    if (STANDALONE_MARKERS.has(marker)) {
      offset = markerAt + 1;
      continue;
    }
    const lengthAt = markerAt + 1;
    if (lengthAt + 1 >= bytes.length) return null;
    const length = (bytes[lengthAt] << 8) | bytes[lengthAt + 1];
    // A segment length counts its own two bytes, so anything below that is
    // malformed and would make this loop stand still.
    if (length < 2 || lengthAt + length > bytes.length) return null;
    if (isStartOfFrame(marker)) {
      // precision (1) then height (2) then width (2), after the length.
      if (length < 7) return null;
      const height = (bytes[lengthAt + 3] << 8) | bytes[lengthAt + 4];
      const width = (bytes[lengthAt + 5] << 8) | bytes[lengthAt + 6];
      if (width < 1 || height < 1) return null;
      return { width, height };
    }
    offset = lengthAt + length;
  }
  return null;
}
