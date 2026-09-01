import { describe, expect, it } from "vitest";
import {
  groupMediaPlacementSuggestions,
  parseJpegExifPlacementSignal,
  suggestMediaPlacement,
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

describe("JPEG EXIF placement parsing (#86)", () => {
  it("extracts only normalized GPS and DateTimeOriginal with timezone", () => {
    expect(parseJpegExifPlacementSignal(jpegWithExif())).toEqual({
      latitude: expect.closeTo(22.278319, 5),
      longitude: expect.closeTo(114.17469, 5),
      capturedAt: "2026-08-30T14:15:00+08:00",
    });
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
    ))).toEqual({ capturedAt: "2026-08-30T14:15:00+08:00" });
  });

  it("accepts exact pole and antimeridian DMS coordinates", () => {
    expect(parseJpegExifPlacementSignal(jpegWithGpsParts(
      [[90, 1], [0, 1], [0, 1]],
      [[180, 1], [0, 1], [0, 1]],
    ))).toEqual({
      latitude: 90,
      longitude: 180,
      capturedAt: "2026-08-30T14:15:00+08:00",
    });
  });
  it("rejects impossible EXIF calendar and clock values instead of normalizing them", () => {
    expect(parseJpegExifPlacementSignal(jpegWithExifTimestamp("2026:13:40 25:61:61"))).toEqual({
      latitude: expect.closeTo(22.278319, 5),
      longitude: expect.closeTo(114.17469, 5),
    });
  });

  it("rejects EXIF year 0000 and falls back to a valid Digitized timestamp", () => {
    expect(parseJpegExifPlacementSignal(jpegWithExifDateFallback(
      "0000:01:01 12:00:00",
      "2026:08:30 14:15:00",
    ))).toEqual({ capturedLocal: "2026-08-30T14:15:00" });
  });

  it("falls back to local capture time when the EXIF offset range is invalid", () => {
    expect(parseJpegExifPlacementSignal(jpegWithExifTimestamp("2026:08:30 14:15:00", "+99:99"))).toEqual({
      latitude: expect.closeTo(22.278319, 5),
      longitude: expect.closeTo(114.17469, 5),
      capturedLocal: "2026-08-30T14:15:00",
    });
  });

  it("does not follow TIFF offsets beyond the declared Exif APP1 segment", () => {
    const jpeg = new Uint8Array(jpegWithExif());
    const view = new DataView(jpeg.buffer);
    view.setUint16(4, 30, false);

    expect(parseJpegExifPlacementSignal(jpeg.buffer)).toBeNull();
  });
  it("returns no signal for non-JPEG or metadata-free bytes", () => {
    expect(parseJpegExifPlacementSignal(new Uint8Array([1, 2, 3]).buffer)).toBeNull();
    expect(parseJpegExifPlacementSignal(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]).buffer)).toBeNull();
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
