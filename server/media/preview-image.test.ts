import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { JPEG_HEADER_WINDOW_BYTES, readJpegPixelSize } from "./preview-image";

/**
 * #265: a progressive JPEG, pinned byte by byte.
 *
 * A progressive still stores the same frame size in the same two fields, under
 * `SOF2` instead of `SOF0`, so the only thing that distinguishes it from the
 * fixtures above is a marker this parser must not treat as a stranger. The
 * bytes are written out here rather than shipped as a file because nothing in
 * this deployment can encode a progressive JPEG, and a header assembled in
 * full view is a stricter fixture than an opaque blob: every segment ahead of
 * the frame is visible, and the dimensions are deliberately not round numbers
 * so an assertion on them cannot pass by accident.
 */
const PROGRESSIVE_JPEG = new Uint8Array([
  0xff, 0xd8, // SOI
  // APP0/JFIF, then an APP1 — two segments the reader must step over.
  0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00,
  0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
  0xff, 0xe1, 0x00, 0x08, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00,
  0xff, 0xdb, 0x00, 0x04, 0x00, 0x00, // a quantisation segment
  // SOF2: length 17, precision 8, height 0x0199 = 409, width 0x0265 = 613,
  // three components.
  0xff, 0xc2, 0x00, 0x11, 0x08, 0x01, 0x99, 0x02, 0x65, 0x03,
  0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
  0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00, // SOS
]);

/**
 * Two pinned real JPEGs, so the measurement is asserted against files rather
 * than against bytes this test invented: one inside the shipped 640 px
 * ceiling, one well over it.
 */
const WITHIN_CEILING = readFileSync(
  new URL("../tests/fixtures/derived-preview-600x467.jpg", import.meta.url),
);
const OVER_CEILING = readFileSync(
  new URL("../tests/fixtures/oversized-still-2048x1024.jpg", import.meta.url),
);

describe("#260 encoded pixel size of a produced preview", () => {
  it("reads the frame size of a real JPEG", () => {
    expect(readJpegPixelSize(WITHIN_CEILING)).toEqual({
      width: 600,
      height: 467,
    });
    expect(readJpegPixelSize(OVER_CEILING)).toEqual({
      width: 2048,
      height: 1024,
    });
  });

  it("reads the frame size of a progressive JPEG", () => {
    // SOF2 is a frame marker like SOF0, so a still encoded progressively is
    // measured rather than refused: refusing it would fail a valid preview.
    expect(readJpegPixelSize(PROGRESSIVE_JPEG)).toEqual({
      width: 613,
      height: 409,
    });
  });

  it("finds a real frame header well inside the read window", () => {
    // #265 reads only the first `JPEG_HEADER_WINDOW_BYTES` of a produced
    // still, so the window has to clear the metadata a real camera JPEG puts
    // in front of its frame. The 2048x1024 fixture carries EXIF, XMP and a
    // 4.5 KB ICC profile, and its SOF still lands in the first few kilobytes.
    const windowed = OVER_CEILING.subarray(0, JPEG_HEADER_WINDOW_BYTES);
    expect(windowed.length).toBeLessThan(OVER_CEILING.length);
    expect(readJpegPixelSize(windowed)).toEqual({ width: 2048, height: 1024 });
    expect(readJpegPixelSize(
      WITHIN_CEILING.subarray(0, JPEG_HEADER_WINDOW_BYTES),
    )).toEqual({ width: 600, height: 467 });
  });

  it("walks past the metadata segments in front of the frame", () => {
    // The fixture carries APP and quantisation segments before its SOF, so a
    // reader that assumed a fixed offset would answer nonsense rather than
    // nothing. Asserting the real answer above is the check; this states why.
    expect(WITHIN_CEILING[2]).toBe(0xff);
    expect(WITHIN_CEILING[3]).not.toBe(0xc0);
  });

  it("answers nothing for bytes that are not a readable still", () => {
    // Every absent answer is the same answer, because the caller treats a
    // truncated file, another format and a malformed frame identically.
    expect(readJpegPixelSize(new Uint8Array([]))).toBeNull();
    expect(readJpegPixelSize(new Uint8Array([0xff, 0xd8]))).toBeNull();
    // A PNG signature.
    expect(readJpegPixelSize(
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    )).toBeNull();
    // A JPEG whose first segment claims a length running off the end.
    expect(readJpegPixelSize(
      new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0xff, 0xff, 0x00]),
    )).toBeNull();
    // A frame declaring a zero edge is not a size anything can be laid out in.
    expect(readJpegPixelSize(new Uint8Array([
      0xff, 0xd8,
      0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x00, 0x02, 0x80, 0x01, 0x11, 0x00,
      0x00,
    ]))).toBeNull();
    // The scan begins with no frame ahead of it.
    expect(readJpegPixelSize(new Uint8Array([0xff, 0xd8, 0xff, 0xda])))
      .toBeNull();
  });

  it("truncates to nothing rather than guessing", () => {
    // Cut the fixture off inside its first segment: the bytes that carry the
    // frame size are gone, so there is no size to report.
    expect(readJpegPixelSize(WITHIN_CEILING.subarray(0, 8))).toBeNull();
  });
});
