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

  it("accepts numeric byte strings like the JSON boundary does", () => {
    const parsed = parseStartUpload({ ...validStart, bytes: "16" });
    expect(parsed?.bytes).toBe(16);
    expect(parsed?.partCount).toBe(1);
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
