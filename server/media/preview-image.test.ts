import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readJpegPixelSize } from "./preview-image";

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
