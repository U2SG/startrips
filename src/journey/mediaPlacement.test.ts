import { describe, expect, it } from "vitest";
import {
  MEDIA_PLACEMENT_PROPOSAL_LIMITS,
  completeMediaPlacementUploadPlan,
  groupMediaPlacementSuggestions,
  isMediaPlacementProposalPlanCurrent,
  parseJpegExifPlacementSignal,
  planMediaPlacementProposals,
  readMediaPlacementSignal,
  suggestMediaPlacement,
  type MediaPlacementProposalInput,
  type MediaPlacementSignal,
} from "./mediaPlacement";
import type { Journey, RoutePoint } from "./types";

function routePoint(
  id: string,
  latitude: number,
  longitude: number,
  occurredAt: string | null,
  sortOrder = 0,
): RoutePoint {
  return {
    id,
    journeyId: "",
    sortOrder,
    latitude,
    longitude,
    label: id,
    isStop: true,
    occurredAt,
    createdAt: "2026-08-01T00:00:00Z",
  };
}

function journey(
  id: string,
  startedOn: string,
  endedOn: string | null,
  points: RoutePoint[],
): Journey {
  return {
    id,
    atlasId: "atlas",
    title: id,
    startedOn,
    endedOn,
    note: "",
    lightColor: "#fff",
    revision: 1,
    createdByUserId: "user",
    createdAt: "2026-08-01T00:00:00Z",
    updatedAt: "2026-08-01T00:00:00Z",
    routePoints: points.map((point) => ({ ...point, journeyId: id })),
    media: [],
  };
}

function proposalInput(
  fileIndex: number,
  signal: MediaPlacementSignal | null,
  contentHash?: string,
  contentHashVerified?: boolean,
): MediaPlacementProposalInput {
  return { fileIndex, signal, contentHash, contentHashVerified };
}

function coordinateSignal(
  latitude: number,
  longitude: number,
  capturedAt: string,
  accuracyMeters: number | null = 15,
): MediaPlacementSignal {
  return {
    latitude,
    longitude,
    capturedAt,
    capturedLocal: capturedAt.replace(/(?:Z|[+-]\d{2}:\d{2})$/, ""),
    spatialSource: "exif",
    spatialGranularity: "coordinate",
    accuracyMeters,
    captureTimeSource: "exif-original",
    timezoneState: "offset-known",
  };
}

function localCoordinateSignal(
  latitude: number,
  longitude: number,
  capturedLocal: string,
  accuracyMeters = 15,
): MediaPlacementSignal {
  return {
    latitude,
    longitude,
    capturedLocal,
    spatialSource: "exif",
    spatialGranularity: "coordinate",
    accuracyMeters,
    captureTimeSource: "exif-original",
    timezoneState: "local-only",
    offsetMinutes: null,
  };
}

function writeEntry(
  view: DataView,
  offset: number,
  tag: number,
  type: number,
  count: number,
  valueOrOffset: number,
  inlineAscii?: string,
) {
  view.setUint16(offset, tag, true);
  view.setUint16(offset + 2, type, true);
  view.setUint32(offset + 4, count, true);
  if (inlineAscii !== undefined) {
    for (let index = 0; index < 4; index += 1) {
      view.setUint8(offset + 8 + index, inlineAscii.charCodeAt(index) || 0);
    }
  } else {
    view.setUint32(offset + 8, valueOrOffset, true);
  }
}

function writeAscii(bytes: Uint8Array, offset: number, value: string) {
  for (let index = 0; index < value.length; index += 1) {
    bytes[offset + index] = value.charCodeAt(index);
  }
  bytes[offset + value.length] = 0;
}

function writeRationals(view: DataView, offset: number, values: ReadonlyArray<readonly [number, number]>) {
  values.forEach(([numerator, denominator], index) => {
    view.setUint32(offset + index * 8, numerator, true);
    view.setUint32(offset + index * 8 + 4, denominator, true);
  });
}

function jpegWithExif() {
  const tiffLength = 197;
  const payloadLength = 6 + tiffLength;
  const segmentLength = payloadLength + 2;
  const bytes = new Uint8Array(2 + 2 + 2 + payloadLength + 2);
  const view = new DataView(bytes.buffer);
  bytes[0] = 0xff;
  bytes[1] = 0xd8;
  bytes[2] = 0xff;
  bytes[3] = 0xe1;
  view.setUint16(4, segmentLength, false);
  const payload = 6;
  writeAscii(bytes, payload, "Exif");
  bytes[payload + 4] = 0;
  bytes[payload + 5] = 0;
  const tiff = payload + 6;
  bytes[tiff] = 0x49;
  bytes[tiff + 1] = 0x49;
  view.setUint16(tiff + 2, 42, true);
  view.setUint32(tiff + 4, 8, true);

  const ifd0 = tiff + 8;
  view.setUint16(ifd0, 2, true);
  writeEntry(view, ifd0 + 2, 0x8769, 4, 1, 38);
  writeEntry(view, ifd0 + 14, 0x8825, 4, 1, 68);
  view.setUint32(ifd0 + 26, 0, true);

  const exifIfd = tiff + 38;
  view.setUint16(exifIfd, 2, true);
  writeEntry(view, exifIfd + 2, 0x9003, 2, 20, 122);
  writeEntry(view, exifIfd + 14, 0x9011, 2, 7, 142);
  view.setUint32(exifIfd + 26, 0, true);

  const gpsIfd = tiff + 68;
  view.setUint16(gpsIfd, 4, true);
  writeEntry(view, gpsIfd + 2, 0x0001, 2, 2, 0, "N");
  writeEntry(view, gpsIfd + 14, 0x0002, 5, 3, 149);
  writeEntry(view, gpsIfd + 26, 0x0003, 2, 2, 0, "E");
  writeEntry(view, gpsIfd + 38, 0x0004, 5, 3, 173);
  view.setUint32(gpsIfd + 50, 0, true);

  writeAscii(bytes, tiff + 122, "2026:08:30 14:15:00");
  writeAscii(bytes, tiff + 142, "+08:00");
  writeRationals(view, tiff + 149, [[22, 1], [16, 1], [4195, 100]]);
  writeRationals(view, tiff + 173, [[114, 1], [10, 1], [28884, 1000]]);
  bytes[bytes.length - 2] = 0xff;
  bytes[bytes.length - 1] = 0xd9;
  return bytes.buffer;
}

function jpegWithTemBeforeExif() {
  const source = new Uint8Array(jpegWithExif());
  const bytes = new Uint8Array(source.length + 2);
  bytes.set(source.subarray(0, 2), 0);
  bytes[2] = 0xff;
  bytes[3] = 0x01;
  bytes.set(source.subarray(2), 4);
  return bytes.buffer;
}

function jpegWithGpsParts(
  latitude: Array<[number, number]>,
  longitude: Array<[number, number]>,
) {
  const buffer = jpegWithExif();
  const view = new DataView(buffer);
  const tiff = 12;
  writeRationals(view, tiff + 149, latitude);
  writeRationals(view, tiff + 173, longitude);
  return buffer;
}
function jpegWithExifTimestamp(dateTimeOriginal: string, offsetTimeOriginal = "+08:00") {
  const bytes = new Uint8Array(jpegWithExif());
  const tiff = 12;
  writeAscii(bytes, tiff + 122, dateTimeOriginal);
  writeAscii(bytes, tiff + 142, offsetTimeOriginal);
  return bytes.buffer;
}

function jpegWithExifDateFallback(original: string, digitized: string) {
  const tiffLength = 96;
  const payloadLength = 6 + tiffLength;
  const segmentLength = payloadLength + 2;
  const bytes = new Uint8Array(2 + 2 + 2 + payloadLength + 2);
  const view = new DataView(bytes.buffer);
  bytes[0] = 0xff; bytes[1] = 0xd8; bytes[2] = 0xff; bytes[3] = 0xe1;
  view.setUint16(4, segmentLength, false);
  const payload = 6;
  writeAscii(bytes, payload, "Exif");
  const tiff = payload + 6;
  bytes[tiff] = 0x49; bytes[tiff + 1] = 0x49;
  view.setUint16(tiff + 2, 42, true);
  view.setUint32(tiff + 4, 8, true);
  const ifd0 = tiff + 8;
  view.setUint16(ifd0, 1, true);
  writeEntry(view, ifd0 + 2, 0x8769, 4, 1, 26);
  view.setUint32(ifd0 + 14, 0, true);
  const exifIfd = tiff + 26;
  view.setUint16(exifIfd, 2, true);
  writeEntry(view, exifIfd + 2, 0x9003, 2, 20, 56);
  writeEntry(view, exifIfd + 14, 0x9004, 2, 20, 76);
  view.setUint32(exifIfd + 26, 0, true);
  writeAscii(bytes, tiff + 56, original);
  writeAscii(bytes, tiff + 76, digitized);
  bytes[bytes.length - 2] = 0xff; bytes[bytes.length - 1] = 0xd9;
  return bytes.buffer;
}

function jpegWithDigitizedExif() {
  const buffer = jpegWithExif();
  const view = new DataView(buffer);
  const tiff = 12;
  const exifIfd = tiff + 38;
  view.setUint16(exifIfd + 2, 0x9004, true);
  view.setUint16(exifIfd + 14, 0x9012, true);
  return buffer;
}

function jpegWithExtendedEvidence(options: {
  original?: string;
  digitized?: string;
  gpsDate?: string;
  gpsTime?: ReadonlyArray<readonly [number, number]>;
  accuracy?: readonly [number, number];
} = {}) {
  const original = options.original ?? "2026:08:30 14:15:00";
  const digitized = options.digitized ?? "2026:08:31 09:30:00";
  const gpsDate = options.gpsDate ?? "2026:09:01";
  const gpsTime = options.gpsTime ?? [[1, 1], [2, 1], [3, 1]] as const;
  const accuracy = options.accuracy ?? [15, 2] as const;
  const tiffLength = 336;
  const payloadLength = 6 + tiffLength;
  const segmentLength = payloadLength + 2;
  const bytes = new Uint8Array(2 + 2 + 2 + payloadLength + 2);
  const view = new DataView(bytes.buffer);
  bytes[0] = 0xff; bytes[1] = 0xd8; bytes[2] = 0xff; bytes[3] = 0xe1;
  view.setUint16(4, segmentLength, false);
  const payload = 6;
  writeAscii(bytes, payload, "Exif");
  bytes[payload + 4] = 0; bytes[payload + 5] = 0;
  const tiff = payload + 6;
  bytes[tiff] = 0x49; bytes[tiff + 1] = 0x49;
  view.setUint16(tiff + 2, 42, true);
  view.setUint32(tiff + 4, 8, true);

  const ifd0 = tiff + 8;
  view.setUint16(ifd0, 2, true);
  writeEntry(view, ifd0 + 2, 0x8769, 4, 1, 38);
  writeEntry(view, ifd0 + 14, 0x8825, 4, 1, 100);
  view.setUint32(ifd0 + 26, 0, true);

  const exifIfd = tiff + 38;
  view.setUint16(exifIfd, 4, true);
  writeEntry(view, exifIfd + 2, 0x9003, 2, 20, 190);
  writeEntry(view, exifIfd + 14, 0x9004, 2, 20, 210);
  writeEntry(view, exifIfd + 26, 0x9011, 2, 7, 230);
  writeEntry(view, exifIfd + 38, 0x9012, 2, 7, 237);
  view.setUint32(exifIfd + 50, 0, true);

  const gpsIfd = tiff + 100;
  view.setUint16(gpsIfd, 7, true);
  writeEntry(view, gpsIfd + 2, 0x0001, 2, 2, 0, "N");
  writeEntry(view, gpsIfd + 14, 0x0002, 5, 3, 244);
  writeEntry(view, gpsIfd + 26, 0x0003, 2, 2, 0, "E");
  writeEntry(view, gpsIfd + 38, 0x0004, 5, 3, 268);
  writeEntry(view, gpsIfd + 50, 0x0007, 5, 3, 292);
  writeEntry(view, gpsIfd + 62, 0x001d, 2, 11, 316);
  writeEntry(view, gpsIfd + 74, 0x001f, 5, 1, 327);
  view.setUint32(gpsIfd + 86, 0, true);

  writeAscii(bytes, tiff + 190, original);
  writeAscii(bytes, tiff + 210, digitized);
  writeAscii(bytes, tiff + 230, "+08:00");
  writeAscii(bytes, tiff + 237, "+09:00");
  writeRationals(view, tiff + 244, [[22, 1], [16, 1], [4195, 100]]);
  writeRationals(view, tiff + 268, [[114, 1], [10, 1], [28884, 1000]]);
  writeRationals(view, tiff + 292, gpsTime);
  writeAscii(bytes, tiff + 316, gpsDate);
  writeRationals(view, tiff + 327, [accuracy]);
  bytes[bytes.length - 2] = 0xff; bytes[bytes.length - 1] = 0xd9;
  return bytes.buffer;
}

describe("JPEG EXIF placement parsing (#86 / #333)", () => {
  it("emits explicit coordinate provenance while keeping missing accuracy unknown", () => {
    expect(parseJpegExifPlacementSignal(jpegWithExif())).toMatchObject({
      latitude: expect.closeTo(22.278319, 5),
      longitude: expect.closeTo(114.17469, 5),
      spatialSource: "exif",
      spatialGranularity: "coordinate",
      accuracyMeters: null,
      capturedAt: "2026-08-30T14:15:00+08:00",
      capturedLocal: "2026-08-30T14:15:00",
      captureTimeSource: "exif-original",
      timezoneState: "offset-known",
      offsetMinutes: 480,
    });
  });

  it("continues from standalone TEM to the following APP1 Exif segment", () => {
    expect(parseJpegExifPlacementSignal(jpegWithTemBeforeExif()))
      .toEqual(parseJpegExifPlacementSignal(jpegWithExif()));
  });

  it.each([
    ["latitude minutes", [[22, 1], [60, 1], [0, 1]], [[114, 1], [10, 1], [0, 1]]],
    ["longitude seconds", [[22, 1], [16, 1], [0, 1]], [[114, 1], [10, 1], [60, 1]]],
    ["latitude past the pole", [[90, 1], [1, 1], [0, 1]], [[114, 1], [10, 1], [0, 1]]],
    ["longitude past the antimeridian", [[22, 1], [16, 1], [0, 1]], [[180, 1], [0, 1], [1, 1]]],
  ] as const)("rejects malformed GPS DMS components: %s", (_label, latitude, longitude) => {
    expect(parseJpegExifPlacementSignal(jpegWithGpsParts(
      latitude.map((part) => [...part]) as Array<[number, number]>,
      longitude.map((part) => [...part]) as Array<[number, number]>,
    ))).toMatchObject({
      spatialSource: "unknown",
      spatialGranularity: "unknown",
      accuracyMeters: null,
      capturedAt: "2026-08-30T14:15:00+08:00",
      captureTimeSource: "exif-original",
    });
  });

  it("accepts exact pole and antimeridian DMS coordinates", () => {
    expect(parseJpegExifPlacementSignal(jpegWithGpsParts(
      [[90, 1], [0, 1], [0, 1]],
      [[180, 1], [0, 1], [0, 1]],
    ))).toMatchObject({
      latitude: 90,
      longitude: 180,
      spatialSource: "exif",
      spatialGranularity: "coordinate",
      accuracyMeters: null,
      capturedAt: "2026-08-30T14:15:00+08:00",
    });
  });

  it("rejects impossible EXIF calendar and clock values instead of normalizing them", () => {
    expect(parseJpegExifPlacementSignal(jpegWithExifTimestamp("2026:13:40 25:61:61"))).toMatchObject({
      latitude: expect.closeTo(22.278319, 5),
      longitude: expect.closeTo(114.17469, 5),
      spatialSource: "exif",
      spatialGranularity: "coordinate",
      captureTimeSource: "unknown",
      timezoneState: "unknown",
    });
  });

  it("rejects EXIF year 0000 and falls back to a local-only Digitized timestamp", () => {
    expect(parseJpegExifPlacementSignal(jpegWithExifDateFallback(
      "0000:01:01 12:00:00",
      "2026:08:30 14:15:00",
    ))).toMatchObject({
      capturedLocal: "2026-08-30T14:15:00",
      captureTimeSource: "exif-digitized",
      timezoneState: "local-only",
      offsetMinutes: null,
    });
  });

  it("never invents a timezone for an EXIF wall clock with no usable offset", () => {
    expect(parseJpegExifPlacementSignal(jpegWithExifTimestamp("2026:08:30 14:15:00", ""))).toMatchObject({
      capturedLocal: "2026-08-30T14:15:00",
      captureTimeSource: "exif-original",
      timezoneState: "local-only",
      offsetMinutes: null,
    });
  });

  it("falls back to local-only capture time when the EXIF offset range is invalid", () => {
    expect(parseJpegExifPlacementSignal(jpegWithExifTimestamp("2026:08:30 14:15:00", "+99:99"))).toMatchObject({
      latitude: expect.closeTo(22.278319, 5),
      longitude: expect.closeTo(114.17469, 5),
      capturedLocal: "2026-08-30T14:15:00",
      captureTimeSource: "exif-original",
      timezoneState: "local-only",
      offsetMinutes: null,
    });
  });

  it("reads GPS horizontal positioning error and keeps Original authoritative over conflicting Digitized/GPS clocks", () => {
    expect(parseJpegExifPlacementSignal(jpegWithExtendedEvidence())).toMatchObject({
      latitude: expect.closeTo(22.278319, 5),
      longitude: expect.closeTo(114.17469, 5),
      spatialSource: "exif",
      spatialGranularity: "coordinate",
      accuracyMeters: 7.5,
      capturedAt: "2026-08-30T14:15:00+08:00",
      captureTimeSource: "exif-original",
      timezoneState: "offset-known",
      offsetMinutes: 480,
    });
  });

  it("uses the GPS clock as UTC evidence only when EXIF Original/Digitized clocks are unusable", () => {
    expect(parseJpegExifPlacementSignal(jpegWithExtendedEvidence({
      original: "0000:01:01 12:00:00",
      digitized: "2026:13:40 25:61:61",
    }))).toMatchObject({
      capturedAt: "2026-09-01T01:02:03.000Z",
      capturedLocal: "2026-09-01T01:02:03",
      captureTimeSource: "gps",
      timezoneState: "offset-known",
      offsetMinutes: 0,
    });
  });

  it("keeps rounded fractional GPS local time aligned with the same UTC instant", () => {
    expect(parseJpegExifPlacementSignal(jpegWithExtendedEvidence({
      original: "0000:01:01 12:00:00",
      digitized: "2026:13:40 25:61:61",
      gpsDate: "2026:09:01",
      gpsTime: [[23, 1], [59, 1], [149999, 2500]],
    }))).toMatchObject({
      capturedAt: "2026-09-02T00:00:00.000Z",
      capturedLocal: "2026-09-02T00:00:00",
      captureTimeSource: "gps",
      timezoneState: "offset-known",
      offsetMinutes: 0,
    });

    expect(parseJpegExifPlacementSignal(jpegWithExtendedEvidence({
      original: "0000:01:01 12:00:00",
      digitized: "2026:13:40 25:61:61",
      gpsTime: [[1, 1], [2, 1], [25, 8]],
    }))).toMatchObject({
      capturedAt: "2026-09-01T01:02:03.125Z",
      capturedLocal: "2026-09-01T01:02:03.125",
    });
  });

  it("does not follow TIFF offsets beyond the declared Exif APP1 segment", () => {
    const jpeg = new Uint8Array(jpegWithExif());
    const view = new DataView(jpeg.buffer);
    view.setUint16(4, 30, false);
    expect(parseJpegExifPlacementSignal(jpeg.buffer)).toBeNull();
  });

  it("pairs DateTimeDigitized with OffsetTimeDigitized", () => {
    expect(parseJpegExifPlacementSignal(jpegWithDigitizedExif())).toMatchObject({
      latitude: expect.closeTo(22.278319, 5),
      longitude: expect.closeTo(114.17469, 5),
      capturedAt: "2026-08-30T14:15:00+08:00",
      captureTimeSource: "exif-digitized",
      timezoneState: "offset-known",
      offsetMinutes: 480,
    });
  });

  it("returns no signal for non-JPEG or metadata-free bytes", () => {
    expect(parseJpegExifPlacementSignal(new Uint8Array([1, 2, 3]).buffer)).toBeNull();
    expect(parseJpegExifPlacementSignal(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]).buffer)).toBeNull();
  });

  it("distinguishes a parsed JPEG signal from JPEG no-evidence", async () => {
    const signal = await readMediaPlacementSignal(new File([jpegWithExif()], "photo.jpg", { type: "image/jpeg" }));
    expect(signal.status).toBe("signal");
    if (signal.status === "signal") expect(signal.signal.spatialGranularity).toBe("coordinate");

    const noEvidence = await readMediaPlacementSignal(new File([
      new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
    ], "empty.jpg", { type: "image/jpeg" }));
    expect(noEvidence).toEqual({ status: "no-evidence" });

    const malformed = await readMediaPlacementSignal(new File([
      new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x01, 0xff, 0xd9]),
    ], "broken.jpg", { type: "image/jpeg" }));
    expect(malformed).toEqual({ status: "no-evidence" });
  });

  it.each([
    ["photo.heic", "image/heic"],
    ["photo.png", "image/png"],
    ["photo.webp", "image/webp"],
    ["clip.mp4", "video/mp4"],
  ])("reports unsupported containers explicitly: %s", async (name, type) => {
    expect(await readMediaPlacementSignal(new File(["x"], name, { type })))
      .toEqual({ status: "unsupported-format" });
  });
});

describe("suggestMediaPlacement (#86)", () => {
  const hongKong = journey("hong-kong", "2026-08-29", "2026-08-31", [
    routePoint("hk-island", 22.2783, 114.1747, "2026-08-30T06:10:00Z"),
    routePoint("lantau", 22.312, 113.921, "2026-08-31T03:00:00Z", 1),
  ]);
  const tokyo = journey("tokyo", "2026-09-10", "2026-09-12", [
    routePoint("shibuya", 35.6595, 139.7005, "2026-09-11T04:00:00Z"),
  ]);

  it("uses reliable GPS-only evidence for a unique nearby point", () => {
    const result = suggestMediaPlacement(
      { latitude: 22.279, longitude: 114.175 },
      [hongKong, tokyo],
      hongKong.id,
    );
    expect(result).toMatchObject({ journeyId: "hong-kong", routePointId: "hk-island" });
    expect(result?.evidence).toContain("gps");
  });

  it("does not upgrade unknown spatial precision from a high-confidence placement suggestion", () => {
    const signal: MediaPlacementSignal = {
      capturedAt: "2026-08-30T14:10:00+08:00",
      spatialSource: "unknown",
      spatialGranularity: "unknown",
      accuracyMeters: null,
      captureTimeSource: "imported",
      timezoneState: "offset-known",
      offsetMinutes: 480,
    };
    const before = structuredClone(signal);
    const result = suggestMediaPlacement(signal, [hongKong, tokyo], hongKong.id);

    expect(result).toMatchObject({
      journeyId: "hong-kong",
      routePointId: "hk-island",
      confidence: "high",
    });
    expect(result?.evidence).not.toContain("gps");
    expect(result).not.toHaveProperty("distanceKm");
    expect(signal).toEqual(before);
    expect(signal.spatialGranularity).toBe("unknown");
    expect(signal.accuracyMeters).toBeNull();
  });

  it("ignores impossible calendar dates instead of rolling them into another Journey", () => {
    const rolledTarget = journey("rolled-target", "2027-02-09", "2027-02-09", []);
    expect(suggestMediaPlacement(
      { capturedLocal: "2026-13-40T14:15:00" },
      [rolledTarget],
      rolledTarget.id,
    )).toBeNull();
  });

  it("uses timestamp-only evidence without inventing timezone precision", () => {
    const result = suggestMediaPlacement(
      { capturedLocal: "2026-08-30T14:15:00" },
      [hongKong, tokyo],
      hongKong.id,
    );
    expect(result).toMatchObject({ journeyId: "hong-kong", routePointId: null });
    expect(result?.evidence).toContain("journey-date");
  });

  it("combines GPS and absolute time into a specific point suggestion", () => {
    const result = suggestMediaPlacement(
      {
        latitude: 22.2784,
        longitude: 114.1748,
        capturedAt: "2026-08-30T14:15:00+08:00",
      },
      [hongKong, tokyo],
      hongKong.id,
    );
    expect(result).toMatchObject({ journeyId: "hong-kong", routePointId: "hk-island" });
    expect(result?.evidence).toEqual(expect.arrayContaining(["gps", "time", "journey-date"]));
  });

  it("rejects strong GPS/time signals that disagree on the destination", () => {
    const result = suggestMediaPlacement(
      {
        latitude: 22.2784,
        longitude: 114.1748,
        capturedAt: "2026-09-11T12:00:00+08:00",
      },
      [hongKong, tokyo],
      hongKong.id,
    );
    expect(result).toBeNull();
  });


  it("uses GPS distance independently when strong GPS and time favor different nearby points", () => {
    const nearbyConflict = journey("nearby-conflict", "2026-08-30", "2026-08-30", [
      routePoint("gps-point", 22.2783, 114.1747, "2026-08-30T00:00:00Z"),
      routePoint("time-point", 22.33, 114.22, "2026-08-30T06:00:00Z", 1),
    ]);
    const result = suggestMediaPlacement(
      {
        latitude: 22.2783,
        longitude: 114.1747,
        capturedAt: "2026-08-30T06:00:00Z",
      },
      [nearbyConflict],
      nearbyConflict.id,
    );
    expect(result).toBeNull();
  });

  it("keeps the capture's local calendar date at timezone boundaries", () => {
    const boundary = journey("boundary", "2026-09-01", "2026-09-01", [
      routePoint("midnight", 0, 0, "2026-08-31T10:30:00Z"),
    ]);
    const result = suggestMediaPlacement(
      { capturedAt: "2026-09-01T00:30:00+14:00" },
      [boundary],
      boundary.id,
    );
    expect(result).toMatchObject({ journeyId: "boundary", routePointId: "midnight" });
    expect(result?.timeDeltaHours).toBeCloseTo(0);
    expect(result?.evidence).toContain("journey-date");
  });

  it("returns no suggestion for missing metadata", () => {
    expect(suggestMediaPlacement({}, [hongKong], hongKong.id)).toBeNull();
    expect(suggestMediaPlacement(null, [hongKong], hongKong.id)).toBeNull();
  });

  it("does not break a same-city multi-Journey tie with a weak context bonus", () => {
    const first = journey("first", "2026-08-30", "2026-08-30", [
      routePoint("first-point", 22.2783, 114.1747, null),
    ]);
    const second = journey("second", "2026-08-30", "2026-08-30", [
      routePoint("second-point", 22.2783, 114.1747, null),
    ]);
    expect(suggestMediaPlacement(
      { latitude: 22.2783, longitude: 114.1747 },
      [first, second],
      first.id,
    )).toBeNull();
  });
});

describe("groupMediaPlacementSuggestions (#86)", () => {
  it("groups strong batch suggestions by destination and preserves file indexes", () => {
    const trip = journey("trip", "2026-08-30", "2026-08-31", [
      routePoint("a", 22.2783, 114.1747, "2026-08-30T06:00:00Z"),
      routePoint("b", 22.312, 113.921, "2026-08-31T03:00:00Z", 1),
    ]);
    const signals: Array<MediaPlacementSignal | null> = [
      { latitude: 22.2783, longitude: 114.1747 },
      { latitude: 22.2784, longitude: 114.1748 },
      { latitude: 22.312, longitude: 113.921 },
      null,
    ];
    expect(groupMediaPlacementSuggestions(signals, [trip], trip.id)).toMatchObject({
      groups: [
        { journeyId: "trip", routePointId: "a", fileIndexes: [0, 1] },
        { journeyId: "trip", routePointId: "b", fileIndexes: [2] },
      ],
      unsuggestedFileIndexes: [3],
    });
  });
});


describe("planMediaPlacementProposals (#335 / ST-114)", () => {
  it("classifies every selected input exactly once with observable basis evidence", () => {
    const target = journey("target", "2026-10-01", "2026-10-01", [
      routePoint("existing", 22.2855, 114.1577, "2026-10-01T02:00:00Z"),
    ]);
    const inputs = [
      proposalInput(20, coordinateSignal(22.2856, 114.1578, "2026-10-01T10:05:00+08:00", 8)),
      proposalInput(10, coordinateSignal(23.1291, 113.2644, "2026-10-01T05:00:00Z", 18)),
      proposalInput(30, {
        capturedLocal: "2026-10-01T14:00:00",
        captureTimeSource: "exif-original",
        timezoneState: "local-only",
      }),
    ];

    const plan = planMediaPlacementProposals(inputs, target, { batchId: "batch-cover" });
    expect(plan.matchExisting).toHaveLength(1);
    expect(plan.matchExisting[0]).toMatchObject({
      routePointId: "existing",
      fileIndexes: [20],
    });
    expect(plan.suggestNew).toHaveLength(1);
    expect(plan.suggestNew[0].fileIndexes).toEqual([10]);
    expect(plan.pendingConfirmation).toHaveLength(1);
    expect(plan.pendingConfirmation[0]).toMatchObject({
      fileIndexes: [30],
      basis: { reason: "missing-coordinate-evidence" },
    });

    const covered = [
      ...plan.matchExisting,
      ...plan.suggestNew,
      ...plan.pendingConfirmation,
    ].flatMap((entry) => entry.fileIndexes).sort((left, right) => left - right);
    expect(covered).toEqual([10, 20, 30]);
    for (const entry of [
      ...plan.matchExisting,
      ...plan.suggestNew,
      ...plan.pendingConfirmation,
    ]) {
      expect(entry.basis.reason.length).toBeGreaterThan(0);
      expect(Array.isArray(entry.basis.evidence)).toBe(true);
      expect(Array.isArray(entry.basis.uncertainty)).toBe(true);
    }
  });

  it("is stable under upload-array shuffles and normalizes offset-known order without coercing local-only time", () => {
    const target = journey("target", "2026-09-30", "2026-10-01", []);
    const inputs = [
      proposalInput(1, coordinateSignal(35.001, -120.001, "2026-09-30T22:30:00-04:00", 10)),
      proposalInput(5, localCoordinateSignal(35.08, -120.08, "2026-10-01T01:00:00", 10)),
      proposalInput(9, coordinateSignal(35, -120, "2026-10-01T10:00:00+08:00", 10)),
    ];
    const first = planMediaPlacementProposals(inputs, target, { batchId: "batch-order" });
    const shuffled = planMediaPlacementProposals(
      [inputs[2], inputs[0], inputs[1]],
      target,
      { batchId: "batch-order" },
    );

    expect(shuffled).toEqual(first);
    expect(first.suggestNew).toHaveLength(2);
    expect(first.suggestNew[0].fileIndexes).toEqual([1, 9]);
    expect(first.suggestNew[0].representative.fileIndex).toBe(9);
    expect(first.suggestNew[1].fileIndexes).toEqual([5]);
    expect(first.suggestNew[1].basis.uncertainty).toContain("local-time-no-offset");
  });

  it("uses explicit distance, time-window and maximum-diameter bounds instead of chain-merging a city", () => {
    expect(MEDIA_PLACEMENT_PROPOSAL_LIMITS.neighborDistanceKm)
      .toBeLessThan(MEDIA_PLACEMENT_PROPOSAL_LIMITS.maxClusterDiameterKm);
    expect(MEDIA_PLACEMENT_PROPOSAL_LIMITS.timeWindowHours).toBeGreaterThan(0);

    const target = journey("target", "2026-09-30", "2026-10-01", []);
    const inputs = [
      proposalInput(0, coordinateSignal(22.28, 114.17, "2026-09-30T23:30:00Z", 12)),
      proposalInput(1, coordinateSignal(22.281, 114.171, "2026-10-01T00:30:00Z", 12)),
      proposalInput(2, coordinateSignal(22.34, 114.23, "2026-10-01T04:00:00Z", 12)),
      proposalInput(3, coordinateSignal(22.341, 114.231, "2026-10-01T05:00:00Z", 12)),
    ];

    const plan = planMediaPlacementProposals(inputs, target, { batchId: "batch-clusters" });
    expect(plan.pendingConfirmation).toEqual([]);
    expect(plan.matchExisting).toEqual([]);
    expect(plan.suggestNew.map((candidate) => candidate.fileIndexes)).toEqual([
      [0, 1],
      [2, 3],
    ]);
    expect(plan.suggestNew.every((candidate) => candidate.basis.reason === "spatiotemporal-cluster"))
      .toBe(true);
  });

  it("keeps unknown accuracy and extreme implied speed in pending confirmation", () => {
    const target = journey("target", "2026-10-01", "2026-10-01", []);
    const inputs = [
      proposalInput(0, coordinateSignal(22.28, 114.17, "2026-10-01T01:00:00Z", null)),
      proposalInput(1, coordinateSignal(22.28, 114.17, "2026-10-01T03:00:00Z", 10)),
      proposalInput(2, coordinateSignal(51.5074, -0.1278, "2026-10-01T03:05:00Z", 10)),
    ];

    const plan = planMediaPlacementProposals(inputs, target, { batchId: "batch-conflict" });
    expect(plan.matchExisting).toEqual([]);
    expect(plan.suggestNew).toEqual([]);
    expect(plan.pendingConfirmation.map((entry) => entry.basis.reason)).toEqual([
      "accuracy-unknown",
      "implausible-speed",
      "implausible-speed",
    ]);
    expect(plan.pendingConfirmation[1].basis.uncertainty).toContain("speed-conflict");
  });

  it("uses only verified content hashes as stable duplicate identity while preserving every selection", () => {
    const target = journey("target", "2026-10-01", "2026-10-01", []);
    const verified = coordinateSignal(22.28, 114.17, "2026-10-01T06:00:00Z", 10);
    const inputs = [
      proposalInput(0, verified, "sha256:verified", true),
      proposalInput(1, { ...verified }, "sha256:verified", true),
      proposalInput(2, coordinateSignal(22.5, 114.17, "2026-10-01T07:00:00Z", 10), "sha256:declared", false),
      proposalInput(3, coordinateSignal(22.7, 114.17, "2026-10-01T08:00:00Z", 10), "sha256:declared", false),
    ];

    const plan = planMediaPlacementProposals(inputs, target, { batchId: "batch-hash" });
    expect(plan.suggestNew.map((candidate) => candidate.fileIndexes)).toEqual([
      [0, 1],
      [2],
      [3],
    ]);
    expect(plan.suggestNew[0].basis.evidence).toContain("verified-content-hash");
    expect(plan.suggestNew[1].basis.evidence).not.toContain("verified-content-hash");
    expect(plan.suggestNew[2].basis.evidence).not.toContain("verified-content-hash");
  });

  it("invalidates stale batch/revision results and cancellation without mutating the proposal", () => {
    const target = journey("target", "2026-10-01", "2026-10-01", []);
    const plan = planMediaPlacementProposals([], target, { batchId: "batch-current" });
    expect(isMediaPlacementProposalPlanCurrent(plan, {
      batchId: "batch-current",
      journeyId: target.id,
      routeRevision: target.revision,
    })).toBe(true);
    expect(isMediaPlacementProposalPlanCurrent(plan, {
      batchId: "batch-current",
      journeyId: target.id,
      routeRevision: target.revision + 1,
    })).toBe(false);
    expect(isMediaPlacementProposalPlanCurrent(plan, {
      batchId: "batch-current",
      journeyId: target.id,
      routeRevision: target.revision,
      cancelled: true,
    })).toBe(false);
    expect(isMediaPlacementProposalPlanCurrent(plan, {
      batchId: "different-batch",
      journeyId: target.id,
      routeRevision: target.revision,
    })).toBe(false);
  });

  it("handles the configured maximum batch as one bounded cluster without changing coverage", () => {
    const target = journey("target", "2026-10-01", "2026-10-01", []);
    const inputs = Array.from(
      { length: MEDIA_PLACEMENT_PROPOSAL_LIMITS.maxInputs },
      (_, fileIndex) => proposalInput(
        fileIndex,
        coordinateSignal(22.28, 114.17, "2026-10-01T06:00:00Z", 10),
      ),
    );

    const plan = planMediaPlacementProposals(inputs, target, { batchId: "max-bounded-batch" });
    expect(plan.matchExisting).toEqual([]);
    expect(plan.pendingConfirmation).toEqual([]);
    expect(plan.suggestNew).toHaveLength(1);
    expect(plan.suggestNew[0].fileIndexes).toHaveLength(MEDIA_PLACEMENT_PROPOSAL_LIMITS.maxInputs);
    expect(plan.suggestNew[0].fileIndexes[0]).toBe(0);
    expect(plan.suggestNew[0].fileIndexes.at(-1)).toBe(MEDIA_PLACEMENT_PROPOSAL_LIMITS.maxInputs - 1);
  });

  it("fails closed when a batch exceeds the explicit bounded input limit", () => {
    const target = journey("target", "2026-10-01", "2026-10-01", []);
    const oversized = Array.from(
      { length: MEDIA_PLACEMENT_PROPOSAL_LIMITS.maxInputs + 1 },
      (_, fileIndex) => proposalInput(fileIndex, null),
    );
    expect(() => planMediaPlacementProposals(oversized, target, { batchId: "too-large" }))
      .toThrow(/bounded input limit/);
  });
});

describe("completeMediaPlacementUploadPlan", () => {
  const suggestion = (journeyId: string, routePointId: string | null) => ({
    journeyId,
    routePointId,
    score: 0.9,
    confidence: "high" as const,
    evidence: ["gps" as const],
  });

  it("returns ordered destination groups only when every file is covered exactly once", () => {
    const batch = {
      groups: [
        { journeyId: "journey-b", routePointId: "point-b", fileIndexes: [3, 1], suggestion: suggestion("journey-b", "point-b") },
        { journeyId: "journey-a", routePointId: null, fileIndexes: [2, 0], suggestion: suggestion("journey-a", null) },
      ],
      unsuggestedFileIndexes: [],
    };
    expect(completeMediaPlacementUploadPlan(batch, 4)).toEqual([
      { journeyId: "journey-a", routePointId: null, fileIndexes: [0, 2] },
      { journeyId: "journey-b", routePointId: "point-b", fileIndexes: [1, 3] },
    ]);
  });

  it("refuses incomplete, duplicate, unsuggested, and out-of-range batches", () => {
    const group = { journeyId: "journey-a", routePointId: null, fileIndexes: [0], suggestion: suggestion("journey-a", null) };
    expect(completeMediaPlacementUploadPlan({ groups: [group], unsuggestedFileIndexes: [] }, 2)).toBeNull();
    expect(completeMediaPlacementUploadPlan({ groups: [group], unsuggestedFileIndexes: [1] }, 2)).toBeNull();
    expect(completeMediaPlacementUploadPlan({ groups: [{ ...group, fileIndexes: [0, 0] }], unsuggestedFileIndexes: [] }, 1)).toBeNull();
    expect(completeMediaPlacementUploadPlan({ groups: [{ ...group, fileIndexes: [1] }], unsuggestedFileIndexes: [] }, 1)).toBeNull();
  });
});
