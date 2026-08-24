import { describe, expect, it } from "vitest";
import {
  parseParts,
  parseReorderInput,
  parseStartUpload,
} from "./uploads";

const JOURNEY_ID = "00000000-0000-4000-8000-000000000001";
const ROUTE_POINT_ID = "00000000-0000-4000-8000-000000000002";

const validStart = {
  journeyId: JOURNEY_ID,
  routePointId: null,
  fileName: "memory.jpg",
  mimeType: "image/jpeg",
  bytes: 8 * 1024 * 1024,
};

describe("parseStartUpload", () => {
  it("accepts a journey-scoped upload and computes its part count", () => {
    const parsed = parseStartUpload(validStart);
    expect(parsed).toMatchObject({
      journeyId: JOURNEY_ID,
      routePointId: null,
      fileName: "memory.jpg",
      mimeType: "image/jpeg",
      bytes: 8 * 1024 * 1024,
      partCount: 1,
    });
  });

  it("accepts an optional route point and a fractional final part", () => {
    const parsed = parseStartUpload({
      ...validStart,
      routePointId: ROUTE_POINT_ID,
      bytes: 8 * 1024 * 1024 + 1,
    });
    expect(parsed?.routePointId).toBe(ROUTE_POINT_ID);
    expect(parsed?.partCount).toBe(2);
  });

  it("rejects missing or malformed journey and route point ids", () => {
    expect(parseStartUpload({ ...validStart, journeyId: "" })).toBeNull();
    expect(parseStartUpload({ ...validStart, journeyId: "not-a-uuid" }))
      .toBeNull();
    expect(parseStartUpload({ ...validStart, routePointId: "not-a-uuid" }))
      .toBeNull();
  });

  it("rejects missing, oversized, or unsupported file metadata", () => {
    expect(parseStartUpload({ ...validStart, fileName: "   " })).toBeNull();
    expect(parseStartUpload({ ...validStart, fileName: "x".repeat(181) }))
      .toBeNull();
    expect(parseStartUpload({ ...validStart, mimeType: "text/html" }))
      .toBeNull();
  });

  it("rejects invalid byte sizes and excessive part counts", () => {
    expect(parseStartUpload({ ...validStart, bytes: 0 })).toBeNull();
    expect(parseStartUpload({ ...validStart, bytes: 1.5 })).toBeNull();
    expect(parseStartUpload({ ...validStart, bytes: 2_000_000_001 }))
      .toBeNull();
    expect(parseStartUpload({ ...validStart, bytes: 8 * 1024 * 1024 * 10_001 }))
      .toBeNull();
  });

  it("accepts a journey soundtrack in every supported audio type", () => {
    for (const mimeType of [
      "audio/mpeg",
      "audio/mp3",
      "audio/mp4",
      "audio/x-m4a",
      "audio/aac",
      "audio/ogg",
      "audio/wav",
      "audio/x-wav",
      "audio/wave",
    ]) {
      expect(parseStartUpload({
        ...validStart,
        fileName: "night.mp3",
        mimeType,
        bytes: 4_000_000,
      })).toMatchObject({ mimeType, partCount: 1 });
    }
    expect(parseStartUpload({
      ...validStart,
      fileName: "notes.aiff",
      mimeType: "audio/aiff",
      bytes: 4_000_000,
    })).toBeNull();
  });

  it("refuses a soundtrack that claims a route point", () => {
    const soundtrack = {
      ...validStart,
      fileName: "night.mp3",
      mimeType: "audio/mpeg",
      bytes: 4_000_000,
    };
    // A soundtrack belongs to the whole journey; a route-point-scoped audio row
    // would be a state the atlas cannot express.
    expect(parseStartUpload({ ...soundtrack, routePointId: ROUTE_POINT_ID }))
      .toBeNull();
    expect(parseStartUpload({ ...soundtrack, routePointId: null }))
      .toMatchObject({ routePointId: null, mimeType: "audio/mpeg" });
    // Photos and videos are still allowed to belong to a route point.
    expect(parseStartUpload({ ...validStart, routePointId: ROUTE_POINT_ID }))
      .toMatchObject({ routePointId: ROUTE_POINT_ID });
  });

  it("caps a soundtrack at 100 MB while visual media keeps its 2 GB limit", () => {
    const soundtrack = {
      ...validStart,
      fileName: "night.mp3",
      mimeType: "audio/mpeg",
    };
    expect(parseStartUpload({ ...soundtrack, bytes: 100 * 1024 * 1024 }))
      .toMatchObject({ bytes: 100 * 1024 * 1024 });
    expect(parseStartUpload({ ...soundtrack, bytes: 100 * 1024 * 1024 + 1 }))
      .toBeNull();
    expect(parseStartUpload({ ...validStart, bytes: 1_000_000_000 }))
      .toMatchObject({ bytes: 1_000_000_000 });
  });

  it("accepts numeric byte strings like the JSON boundary does", () => {
    const parsed = parseStartUpload({ ...validStart, bytes: "16" });
    expect(parsed?.bytes).toBe(16);
    expect(parsed?.partCount).toBe(1);
  });

  it("accepts an optional sha256 content hash and normalizes its case", () => {
    const hash = "a".repeat(64);
    expect(parseStartUpload({ ...validStart, contentHash: hash })?.contentHash)
      .toBe(hash);
    expect(parseStartUpload(validStart)?.contentHash).toBeNull();
    expect(parseStartUpload({
      ...validStart,
      contentHash: "A".repeat(64),
    })?.contentHash).toBe(hash);
  });

  it("rejects malformed content hashes", () => {
    expect(parseStartUpload({ ...validStart, contentHash: "abc" })).toBeNull();
    expect(parseStartUpload({ ...validStart, contentHash: "a".repeat(63) }))
      .toBeNull();
    expect(parseStartUpload({ ...validStart, contentHash: "a".repeat(65) }))
      .toBeNull();
    expect(parseStartUpload({ ...validStart, contentHash: 42 })).toBeNull();
  });
});

describe("parseParts", () => {
  it("accepts complete sequential parts", () => {
    expect(parseParts([
      { partNumber: 1, etag: "a" },
      { partNumber: 2, etag: "b" },
    ], 2)).toEqual([
      { partNumber: 1, etag: "a" },
      { partNumber: 2, etag: "b" },
    ]);
  });

  it("rejects a part list that does not match the declared count", () => {
    expect(parseParts([{ partNumber: 1, etag: "a" }], 2)).toBeNull();
    expect(parseParts([], 0)).toBeNull();
  });

  it("rejects gaps, duplicates, and out-of-range part numbers", () => {
    expect(parseParts([
      { partNumber: 1, etag: "a" },
      { partNumber: 3, etag: "c" },
    ], 3)).toBeNull();
    expect(parseParts([
      { partNumber: 1, etag: "a" },
      { partNumber: 1, etag: "b" },
    ], 2)).toBeNull();
    expect(parseParts([{ partNumber: 0, etag: "a" }], 1)).toBeNull();
  });

  it("rejects missing or oversized etags", () => {
    expect(parseParts([{ partNumber: 1, etag: "" }], 1)).toBeNull();
    expect(parseParts([{ partNumber: 1, etag: "x".repeat(1025) }], 1))
      .toBeNull();
  });
});

describe("parseReorderInput", () => {
  it("accepts a unique ordered asset list for a journey", () => {
    expect(parseReorderInput({
      journeyId: JOURNEY_ID,
      assetIds: [
        "00000000-0000-4000-8000-000000000011",
        "00000000-0000-4000-8000-000000000012",
      ],
    })).toEqual({
      journeyId: JOURNEY_ID,
      assetIds: [
        "00000000-0000-4000-8000-000000000011",
        "00000000-0000-4000-8000-000000000012",
      ],
    });
  });

  it("rejects malformed journeys, ids, and duplicate or empty lists", () => {
    expect(parseReorderInput({ journeyId: "bad", assetIds: [] })).toBeNull();
    expect(parseReorderInput({ journeyId: JOURNEY_ID, assetIds: [] }))
      .toBeNull();
    expect(parseReorderInput({
      journeyId: JOURNEY_ID,
      assetIds: ["not-a-uuid"],
    })).toBeNull();
    expect(parseReorderInput({
      journeyId: JOURNEY_ID,
      assetIds: [
        "00000000-0000-4000-8000-000000000011",
        "00000000-0000-4000-8000-000000000011",
      ],
    })).toBeNull();
  });

  it("rejects oversized order lists", () => {
    const assetIds = Array.from(
      { length: 257 },
      (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    );
    expect(parseReorderInput({ journeyId: JOURNEY_ID, assetIds })).toBeNull();
  });
});
