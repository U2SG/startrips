import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  JourneyComposer,
  parseCoordinateInput,
  persistJourneyDraft,
} from "./JourneyComposer";
import type { Journey, JourneyInput } from "./types";

const input: JourneyInput = {
  title: "Night train",
  startedOn: "2026-08-11",
  endedOn: null,
  note: "",
  lightColor: "#f4ce73",
  routePoints: [{
    latitude: 31.2304,
    longitude: 121.4737,
    label: "Shanghai",
    isStop: true,
    occurredAt: null,
  }],
};

const journey = {
  id: "journey-1",
  routePoints: [],
  media: [],
} as unknown as Journey;

describe("persistJourneyDraft", () => {
  it("does not silently turn an empty coordinate into zero", () => {
    expect(parseCoordinateInput("", -90, 90)).toBeNull();
    expect(parseCoordinateInput("   ", -180, 180)).toBeNull();
    expect(parseCoordinateInput("0", -90, 90)).toBe(0);
    expect(parseCoordinateInput("22.543096", -90, 90)).toBe(22.543096);
    expect(parseCoordinateInput("-90", -90, 90)).toBe(-90);
    expect(parseCoordinateInput("180", -180, 180)).toBe(180);
    expect(parseCoordinateInput("90.000001", -90, 90)).toBeNull();
    expect(parseCoordinateInput("-180.000001", -180, 180)).toBeNull();
  });

  it("renders one composer surface with precise coordinates collapsed", () => {
    const markup = renderToStaticMarkup(createElement(JourneyComposer, {
      open: true,
      onClose: () => undefined,
      onSaved: () => undefined,
      onGlobePickRequest: () => undefined,
    }));

    expect(markup).not.toContain("journey-composer__steps");
    expect(markup).toContain("01 · MEMORY");
    expect(markup).toContain("02 · JOURNEY");
    expect(markup).toContain("03 · TRACE");
    expect(markup).toContain('<details class="journey-precise-location">');
    expect(markup).toContain("保存到星球");
  });

  it("creates first, uploads files sequentially with two part workers, and reports progress", async () => {
    const calls: string[] = [];
    const create = vi.fn(async () => {
      calls.push("create");
      return journey;
    });
    const upload = vi.fn(async (options: Parameters<NonNullable<Parameters<typeof persistJourneyDraft>[0]["upload"]>>[0]) => {
      calls.push(options.fileName);
      expect(options.concurrency).toBe(2);
      options.onProgress?.({ uploadedBytes: options.file.size, totalBytes: options.file.size });
      return {} as Awaited<ReturnType<NonNullable<Parameters<typeof persistJourneyDraft>[0]["upload"]>>>;
    });
    const files = [
      { name: "a.jpg", size: 10, type: "image/jpeg" },
      { name: "b.mp4", size: 20, type: "video/mp4" },
    ] as File[];
    const onProgress = vi.fn();

    const result = await persistJourneyDraft({ input, files, create, upload, onProgress });

    expect(calls).toEqual(["create", "a.jpg", "b.mp4"]);
    expect(result).toMatchObject({ journey, uploadedCount: 2, mediaErrors: [] });
    expect(onProgress).toHaveBeenLastCalledWith({
      fileName: "b.mp4",
      uploadedBytes: 30,
      totalBytes: 30,
    });
  });

  it("keeps the saved journey and reports individual media failures", async () => {
    const files = [
      { name: "a.jpg", size: 10, type: "image/jpeg" },
      { name: "b.jpg", size: 10, type: "image/jpeg" },
    ] as File[];
    const upload = vi.fn()
      .mockRejectedValueOnce(new Error("storage unavailable"))
      .mockResolvedValueOnce({});

    const result = await persistJourneyDraft({
      input,
      files,
      create: async () => journey,
      upload,
    });

    expect(result.uploadedCount).toBe(1);
    expect(result.mediaErrors).toEqual([{
      fileIndex: 0,
      fileName: "a.jpg",
      message: "storage unavailable",
    }]);
  });
});
