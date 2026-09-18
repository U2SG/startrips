import { describe, expect, it } from "vitest";
import {
  UNKNOWN_MEDIA_RECORDED_EVIDENCE,
  effectiveMediaSpatialEvidence,
  parseDisplayStateWrite,
  parseRecordedEvidenceWrite,
} from "./media-evidence";

const UNKNOWN_TIME = {
  source: "unknown",
  timezone: "unknown",
  local: null,
  instant: null,
  offsetMinutes: null,
} as const;

const UNKNOWN_SPATIAL = {
  source: "unknown",
  granularity: "unknown",
  latitude: null,
  longitude: null,
  accuracyMeters: null,
  label: null,
} as const;

function recorded(overrides: Record<string, unknown> = {}) {
  return {
    expectedRevision: 0,
    spatial: UNKNOWN_SPATIAL,
    captureTime: UNKNOWN_TIME,
    ...overrides,
  };
}
describe("media evidence validation", () => {
  it("preserves coordinate evidence without inventing accuracy", () => {
    const parsed = parseRecordedEvidenceWrite(recorded({
      spatial: {
        source: "exif",
        granularity: "coordinate",
        latitude: 22.543096,
        longitude: 114.057865,
        accuracyMeters: null,
        label: null,
      },
      captureTime: {
        source: "exif-original",
        timezone: "offset-known",
        local: "2026-09-18T13:14:15",
        instant: "2026-09-18T05:14:15.000Z",
        offsetMinutes: 480,
      },
    }));

    expect(parsed).not.toBeNull();
    expect(parsed?.recorded.spatial.accuracyMeters).toBeNull();
    expect(parsed?.recorded.captureTime.instant?.toISOString())
      .toBe("2026-09-18T05:14:15.000Z");
  });

  it("keeps local-only and explicit unknown time distinct", () => {
    const localOnly = parseRecordedEvidenceWrite(recorded({
      captureTime: {
        source: "exif-digitized",
        timezone: "local-only",
        local: "2026-02-28T23:59:59.123456",
        instant: null,
        offsetMinutes: null,
      },
    }));
    expect(localOnly?.recorded.captureTime.timezone).toBe("local-only");
    expect(parseRecordedEvidenceWrite(recorded())?.recorded)
      .toEqual(UNKNOWN_MEDIA_RECORDED_EVIDENCE);
  });

  it.each([
    ["latitude", { latitude: 91, longitude: 0, accuracyMeters: null }],
    ["longitude", { latitude: 0, longitude: 181, accuracyMeters: null }],
    ["accuracy", { latitude: 0, longitude: 0, accuracyMeters: -1 }],
  ])("rejects invalid coordinate %s", (_name, values) => {
    expect(parseRecordedEvidenceWrite(recorded({
      spatial: {
        source: "exif",
        granularity: "coordinate",
        ...values,
        label: null,
      },
    }))).toBeNull();
  });

  it("rejects precision upgrades and contradictory spatial shapes", () => {
    expect(parseRecordedEvidenceWrite(recorded({
      spatial: {
        source: "unknown",
        granularity: "coordinate",
        latitude: 1,
        longitude: 2,
        accuracyMeters: null,
        label: null,
      },
    }))).toBeNull();
    expect(parseRecordedEvidenceWrite(recorded({
      spatial: {
        source: "imported",
        granularity: "city",
        latitude: 1,
        longitude: 2,
        accuracyMeters: null,
        label: "Shenzhen",
      },
    }))).toBeNull();
  });

  it("rejects impossible local dates and invalid timezone combinations", () => {
    expect(parseRecordedEvidenceWrite(recorded({
      captureTime: {
        source: "exif-original",
        timezone: "local-only",
        local: "2026-02-31T12:00:00",
        instant: null,
        offsetMinutes: null,
      },
    }))).toBeNull();
    expect(parseRecordedEvidenceWrite(recorded({
      captureTime: {
        source: "exif-original",
        timezone: "local-only",
        local: "2026-09-18T12:00:00",
        instant: "2026-09-18T04:00:00Z",
        offsetMinutes: 480,
      },
    }))).toBeNull();
    expect(parseRecordedEvidenceWrite(recorded({ expectedRevision: -1 })))
      .toBeNull();
    expect(parseRecordedEvidenceWrite(recorded({ expectedRevision: "0" })))
      .toBeNull();
  });

  it("rejects offset-known timestamps whose local wall clock contradicts the instant", () => {
    expect(parseRecordedEvidenceWrite(recorded({
      captureTime: {
        source: "exif-original",
        timezone: "offset-known",
        local: "2026-09-18T08:30:00",
        instant: "2026-09-18T01:30:00.000Z",
        offsetMinutes: 480,
      },
    }))).toBeNull();
  });

  it("validates correction shapes separately from recorded evidence", () => {
    expect(parseDisplayStateWrite({
      expectedRevision: 3,
      hidden: false,
      correction: {
        granularity: "coordinate",
        latitude: 1.3521,
        longitude: 103.8198,
        label: "Marina Bay",
      },
    })).toMatchObject({ expectedRevision: 3 });
    expect(parseDisplayStateWrite({
      expectedRevision: 3,
      hidden: false,
      correction: { granularity: "city", latitude: 1, longitude: 2, label: "SG" },
    })).toBeNull();
  });

  it("derives effective location without mutating recorded provenance", () => {
    const recordedEvidence = {
      spatial: {
        source: "exif" as const,
        granularity: "coordinate" as const,
        latitude: 22.543096,
        longitude: 114.057865,
        accuracyMeters: 35,
        label: null,
      },
      captureTime: UNKNOWN_TIME,
    };
    expect(effectiveMediaSpatialEvidence(recordedEvidence, {
      hidden: false,
      correction: null,
    })).toMatchObject({ source: "recorded", provenance: "exif", accuracyMeters: 35 });

    expect(effectiveMediaSpatialEvidence(recordedEvidence, {
      hidden: false,
      correction: {
        granularity: "city",
        latitude: null,
        longitude: null,
        label: "Hong Kong",
      },
    })).toEqual({
      source: "user-correction",
      provenance: null,
      granularity: "city",
      latitude: null,
      longitude: null,
      accuracyMeters: null,
      label: "Hong Kong",
    });
    expect(effectiveMediaSpatialEvidence(recordedEvidence, {
      hidden: true,
      correction: null,
    })).toBeNull();
  });
});
