import { describe, expect, it } from "vitest";
import {
  MAX_MOVE_UNDO_ORDER,
  mediaKindOf,
  mediaOrderAfterMove,
  moveUndoOrdersFitLimit,
  parseMoveMediaInput,
  parseUndoMediaMoveInput,
  parseUndoMoveMediaInput,
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


describe("moveUndoOrdersFitLimit", () => {
  it("accepts the exact undo-safe boundary and rejects an oversized same-Journey order", () => {
    const boundary = Array.from({ length: MAX_MOVE_UNDO_ORDER }, (_, index) => String(index));
    expect(moveUndoOrdersFitLimit(boundary)).toBe(true);
    expect(moveUndoOrdersFitLimit([...boundary, "overflow"])).toBe(false);
  });

  it("requires every cross-Journey order to fit the same undo-safe contract", () => {
    const safe = Array.from({ length: 8 }, (_, index) => String(index));
    const oversized = Array.from({ length: MAX_MOVE_UNDO_ORDER + 1 }, (_, index) => String(index));
    expect(moveUndoOrdersFitLimit(safe, safe)).toBe(true);
    expect(moveUndoOrdersFitLimit(safe, oversized)).toBe(false);
  });
});

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

describe("mediaKindOf", () => {
  it("separates audio from visual content so dedupe cannot cross kinds", () => {
    // The same MP4 bytes can arrive as a video and as a soundtrack; the
    // deduplication scope has to tell those apart.
    expect(mediaKindOf("video/mp4")).toBe("video");
    expect(mediaKindOf("audio/mp4")).toBe("audio");
    expect(mediaKindOf("audio/mp4")).not.toBe(mediaKindOf("video/mp4"));
    expect(mediaKindOf("image/jpeg")).toBe("image");
    // Aliases of one kind stay in the same scope, which keeps replacing a
    // soundtrack with the same file idempotent.
    expect(mediaKindOf("audio/x-m4a")).toBe(mediaKindOf("audio/mpeg"));
  });

  it("falls back to a scope that matches nothing for malformed types", () => {
    expect(mediaKindOf("")).toBe("unknown");
    expect(mediaKindOf("audio")).toBe("audio");
    expect(mediaKindOf("Audio/MP4")).toBe("unknown");
    expect(mediaKindOf("%/mp4")).toBe("unknown");
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
      { length: 2_049 },
      (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    );
    expect(parseReorderInput({ journeyId: JOURNEY_ID, assetIds })).toBeNull();
  });
});

describe("parseMoveMediaInput", () => {
  const assetIds = [
    "00000000-0000-4000-8000-000000000011",
    "00000000-0000-4000-8000-000000000012",
  ];

  it("accepts a batch move onto a route point", () => {
    expect(parseMoveMediaInput({
      journeyId: JOURNEY_ID,
      assetIds,
      routePointId: ROUTE_POINT_ID,
    })).toEqual({ journeyId: JOURNEY_ID, assetIds, routePointId: ROUTE_POINT_ID });
  });

  it("accepts a batch move back to the whole journey (null route point)", () => {
    expect(parseMoveMediaInput({ journeyId: JOURNEY_ID, assetIds }))
      .toEqual({ journeyId: JOURNEY_ID, assetIds, routePointId: null });
    expect(parseMoveMediaInput({ journeyId: JOURNEY_ID, assetIds, routePointId: null }))
      .toEqual({ journeyId: JOURNEY_ID, assetIds, routePointId: null });
  });

  it("rejects malformed journeys, route points, ids, and duplicate or empty lists", () => {
    expect(parseMoveMediaInput({ journeyId: "bad", assetIds, routePointId: ROUTE_POINT_ID }))
      .toBeNull();
    expect(parseMoveMediaInput({ journeyId: JOURNEY_ID, assetIds: [], routePointId: ROUTE_POINT_ID }))
      .toBeNull();
    expect(parseMoveMediaInput({ journeyId: JOURNEY_ID, assetIds: ["not-a-uuid"], routePointId: ROUTE_POINT_ID }))
      .toBeNull();
    expect(parseMoveMediaInput({
      journeyId: JOURNEY_ID,
      assetIds: [assetIds[0], assetIds[0]],
      routePointId: ROUTE_POINT_ID,
    })).toBeNull();
    expect(parseMoveMediaInput({ journeyId: JOURNEY_ID, assetIds, routePointId: "bad" }))
      .toBeNull();
    expect(parseMoveMediaInput({ journeyId: JOURNEY_ID, assetIds, routePointId: 42 }))
      .toBeNull();
  });

  it("accepts an optional cross-journey destination while preserving the legacy shape", () => {
    const targetJourneyId = "00000000-0000-4000-8000-000000000003";
    const assetIds = ["00000000-0000-4000-8000-000000000011"];
    expect(parseMoveMediaInput({
      journeyId: JOURNEY_ID,
      targetJourneyId,
      assetIds,
      routePointId: ROUTE_POINT_ID,
    })).toEqual({ journeyId: JOURNEY_ID, targetJourneyId, assetIds, routePointId: ROUTE_POINT_ID });
    expect(parseMoveMediaInput({ journeyId: JOURNEY_ID, targetJourneyId: "bad", assetIds, routePointId: null }))
      .toBeNull();
  });

  it("rejects oversized selections", () => {
    const oversized = Array.from(
      { length: 257 },
      (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    );
    expect(parseMoveMediaInput({ journeyId: JOURNEY_ID, assetIds: oversized, routePointId: ROUTE_POINT_ID }))
      .toBeNull();
  });
});

describe("parseUndoMediaMoveInput", () => {
  const input = {
    sourceJourneyId: JOURNEY_ID,
    targetJourneyId: "00000000-0000-4000-8000-000000000003",
    assetIds: ["00000000-0000-4000-8000-000000000011"],
    targetRoutePointId: null,
    sourceOrder: [
      "00000000-0000-4000-8000-000000000011",
      "00000000-0000-4000-8000-000000000012",
    ],
    targetOrder: ["00000000-0000-4000-8000-000000000011"],
    sourceCoverMediaAssetId: "00000000-0000-4000-8000-000000000011",
    placements: [{
      assetId: "00000000-0000-4000-8000-000000000011",
      routePointId: ROUTE_POINT_ID,
    }],
  };

  it("accepts a complete server-generated undo descriptor", () => {
    expect(parseUndoMediaMoveInput(input)).toEqual(input);
  });

  it("rejects malformed, duplicate, mismatched, and same-journey descriptors", () => {
    expect(parseUndoMediaMoveInput({ ...input, targetJourneyId: JOURNEY_ID })).toBeNull();
    expect(parseUndoMediaMoveInput({ ...input, assetIds: [input.assetIds[0], input.assetIds[0]] })).toBeNull();
    expect(parseUndoMediaMoveInput({ ...input, placements: [] })).toBeNull();
    expect(parseUndoMediaMoveInput({ ...input, targetOrder: [] })).toBeNull();
    expect(parseUndoMediaMoveInput({ ...input, sourceOrder: ["00000000-0000-4000-8000-000000000012"] })).toBeNull();
    expect(parseUndoMediaMoveInput({
      ...input,
      placements: [{ assetId: input.assetIds[0], routePointId: "bad" }],
    })).toBeNull();
  });
});

describe("mediaOrderAfterMove", () => {
  it("preserves selected relative order while appending the selection", () => {
    expect(mediaOrderAfterMove(["a", "b", "c", "d"], ["c", "a"]))
      .toEqual(["b", "d", "a", "c"]);
  });
});

describe("parseUndoMoveMediaInput", () => {
  const assetA = "00000000-0000-4000-8000-000000000011";
  const assetB = "00000000-0000-4000-8000-000000000012";

  it("accepts mixed previous assignments plus the pre-move canonical order", () => {
    expect(parseUndoMoveMediaInput({
      journeyId: JOURNEY_ID,
      expectedRoutePointId: ROUTE_POINT_ID,
      assignments: [
        { assetId: assetA, routePointId: null },
        { assetId: assetB, routePointId: "00000000-0000-4000-8000-000000000003" },
      ],
      assetOrder: [assetA, assetB],
    })).toEqual({
      journeyId: JOURNEY_ID,
      expectedRoutePointId: ROUTE_POINT_ID,
      assignments: [
        { assetId: assetA, routePointId: null },
        { assetId: assetB, routePointId: "00000000-0000-4000-8000-000000000003" },
      ],
      assetOrder: [assetA, assetB],
    });
  });

  it("allows a full Journey order larger than the old 2,048-item undo cap", () => {
    const assetOrder = Array.from(
      { length: 257 },
      (_, index) => `00000000-0000-4000-8000-${String(index + 1000).padStart(12, "0")}`,
    );
    const selected = assetOrder.slice(0, 2);
    expect(parseUndoMoveMediaInput({
      journeyId: JOURNEY_ID,
      expectedRoutePointId: ROUTE_POINT_ID,
      assignments: selected.map((assetId) => ({ assetId, routePointId: null })),
      assetOrder,
    })).toMatchObject({ assetOrder });
  });

  it("rejects malformed or stale-shaped undo payloads before the transaction", () => {
    expect(parseUndoMoveMediaInput({
      journeyId: JOURNEY_ID,
      expectedRoutePointId: ROUTE_POINT_ID,
      assignments: [],
      assetOrder: [assetA],
    })).toBeNull();
    expect(parseUndoMoveMediaInput({
      journeyId: JOURNEY_ID,
      expectedRoutePointId: "bad",
      assignments: [{ assetId: assetA, routePointId: null }],
      assetOrder: [assetA],
    })).toBeNull();
    expect(parseUndoMoveMediaInput({
      journeyId: JOURNEY_ID,
      expectedRoutePointId: ROUTE_POINT_ID,
      assignments: [
        { assetId: assetA, routePointId: null },
        { assetId: assetA, routePointId: null },
      ],
      assetOrder: [assetA],
    })).toBeNull();
    expect(parseUndoMoveMediaInput({
      journeyId: JOURNEY_ID,
      expectedRoutePointId: ROUTE_POINT_ID,
      assignments: [{ assetId: assetA, routePointId: null }],
      assetOrder: [assetB],
    })).toBeNull();
  });
});
