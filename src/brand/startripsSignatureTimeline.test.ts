import { describe, expect, it } from "vitest";
import {
  STARTRIPS_SIGNATURE_CLIPS,
  getStartripsSignatureClip,
  isUniformTimelineScale,
  sampleStartripsSignaturePose,
} from "./startripsSignatureTimeline";
import { STARTRIPS_V12_AUTHORED_TIMELINE } from "./startripsV12MotionSource";

describe("Startrips v12 semantic clips", () => {
  it("keeps the authored full clip intact", () => {
    const full = getStartripsSignatureClip("full");
    expect(full.durationMs).toBe(25_400);
    expect(full.events).toHaveLength(STARTRIPS_V12_AUTHORED_TIMELINE.events.length);
  });

  it("keeps front-hoof support before rear-leg transfer in every derived clip that contains the climb", () => {
    for (const clip of Object.values(STARTRIPS_SIGNATURE_CLIPS)) {
      const front = clip.events.filter((entry) => entry.id === "front-near-climb" || entry.id === "front-far-climb");
      const rear = clip.events.filter((entry) => entry.id === "hind-near-transfer" || entry.id === "hind-far-transfer");
      if (front.length === 0 || rear.length === 0) continue;
      expect(Math.max(...front.map((entry) => entry.clipStartMs)))
        .toBeLessThan(Math.min(...rear.map((entry) => entry.clipStartMs)));
    }
  });

  it("keeps head/eye direction keys coupled to the same star target in every clip", () => {
    for (const clip of Object.values(STARTRIPS_SIGNATURE_CLIPS)) {
      const prefix = clip.events.some((entry) => entry.id === "follow-star") ? "follow" : "notice";
      const star = clip.events.find((entry) => entry.id === `${prefix}-star`);
      const head = clip.events.find((entry) => entry.id === `${prefix}-head`);
      const eye = clip.events.find((entry) => entry.id === `${prefix}-eye`);
      expect(star).toBeTruthy();
      expect(head).toMatchObject({ clipStartMs: star?.clipStartMs, clipEndMs: star?.clipEndMs });
      expect(eye).toMatchObject({ clipStartMs: star?.clipStartMs, clipEndMs: star?.clipEndMs });
    }
  });

  it("rejects a uniform playback-rate scale and keeps loading intentionally remapped", () => {
    const full = getStartripsSignatureClip("full");
    const uniform = {
      ...full,
      durationMs: 3_600,
      events: full.events.map((entry) => ({
        ...entry,
        clipStartMs: entry.sourceStartMs * (3_600 / 25_400),
        clipEndMs: entry.sourceEndMs * (3_600 / 25_400),
      })),
    };
    const loading = getStartripsSignatureClip("loading");
    expect(isUniformTimelineScale(uniform)).toBe(true);
    expect(loading.durationMs).toBeLessThanOrEqual(4_000);
    expect(loading.events.some((entry) => entry.id === "final-leap")).toBe(false);
    expect(isUniformTimelineScale(loading)).toBe(false);
  });

  it("settles every clip to the approved static rest pose", () => {
    for (const clip of Object.values(STARTRIPS_SIGNATURE_CLIPS)) {
      const pose = sampleStartripsSignaturePose(clip.name, clip.durationMs);
      expect(pose).toMatchObject({
        rootX: 0, rootY: 0, bodyY: 0, headRotateDeg: 0,
        starX: 0, starY: 0, starScale: 1,
        legFnY: 0, legFfY: 0, legHnY: 0, legHfY: 0,
      });
    }
  });

  it("keeps loading below four seconds while preserving staggered contacts", () => {
    const loading = getStartripsSignatureClip("loading");
    const starts = Object.fromEntries(loading.events.map((entry) => [entry.id, entry.clipStartMs]));
    expect(loading.durationMs).toBe(3_600);
    expect(starts["front-near-climb"]).toBeLessThan(starts["front-far-climb"]);
    expect(starts["front-far-climb"]).toBeLessThan(starts["hind-near-transfer"]);
    expect(starts["hind-near-transfer"]).toBeLessThan(starts["hind-far-transfer"]);
  });

  it("derives a bounded non-looping recovery clip from the canonical v12 events", () => {
    const recovery = getStartripsSignatureClip("recovery");
    expect(recovery.durationMs).toBeGreaterThanOrEqual(3_000);
    expect(recovery.durationMs).toBeLessThanOrEqual(5_000);
    expect(recovery.loop).toBe(false);
    expect(isUniformTimelineScale(recovery)).toBe(false);
    expect(recovery.events.every((entry) => STARTRIPS_V12_AUTHORED_TIMELINE.events.some((source) => source.id === entry.id))).toBe(true);
    expect(recovery.events.at(-1)?.kind).toBe("settle");
    expect(sampleStartripsSignaturePose("recovery", recovery.durationMs)).toMatchObject({
      rootX: 0, rootY: 0, bodyY: 0, headRotateDeg: 0, starScale: 1,
    });
  });

});
