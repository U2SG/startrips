import { describe, expect, it } from "vitest";
import { validatePersonalMomentImage } from "../../templates/personal-gallery/preparePersonalMomentImage";
import type { PersonalMoment, UploadDraft } from "../experience/types";
import {
  coordinatesForPlace,
  loadPersonalMoments,
  normalizeUploadDraft,
  savePersonalMoments,
} from "./personalMoments";

function createStorage(initialValue: string | null = null, shouldThrow = false): Storage {
  let value = initialValue;
  return {
    get length() { return value === null ? 0 : 1; },
    clear() { value = null; },
    getItem() {
      if (shouldThrow) throw new Error("storage unavailable");
      return value;
    },
    key() { return value === null ? null : "art-history-twin:personal-moments"; },
    removeItem() { value = null; },
    setItem(_key, nextValue) {
      if (shouldThrow) throw new Error("storage unavailable");
      value = nextValue;
    },
  };
}

const moment: PersonalMoment = {
  id: "personal-001",
  title: "Kobe with Gianna",
  note: "A private memory.",
  year: "2020",
  place: "Los Angeles",
  imageUrl: "/session/personal-001.webp",
  point: { lat: 34.0522, lon: -118.2437 },
};

describe("personal moment image validation", () => {
  it("accepts supported images within 8 MB and rejects invalid inputs", () => {
    expect(validatePersonalMomentImage({ type: "image/jpeg", size: 1024 })).toBeNull();
    expect(validatePersonalMomentImage({ type: "image/gif", size: 1024 })).toMatch(/JPG/);
    expect(validatePersonalMomentImage({ type: "image/png", size: 8 * 1024 * 1024 + 1 })).toMatch(/8 MB/);
  });
});

describe("personal moment normalization and coordinates", () => {
  it("normalizes metadata without inventing required values", () => {
    const draft: UploadDraft = {
      title: "  Kobe   with Gianna  ",
      note: "  A private\n memory.  ",
      year: " 2020 ",
      place: "  Los   Angeles ",
      imageUrl: "/qa/upload-filled-artwork.jpg",
      previewUrl: "/qa/upload-filled-artwork.jpg",
      lightColor: "#f4ce73",
    };

    expect(normalizeUploadDraft(draft)).toMatchObject({
      title: "Kobe with Gianna",
      note: "A private memory.",
      year: "2020",
      place: "Los Angeles",
      previewUrl: "/qa/upload-filled-artwork.jpg",
      lightColor: "#f4ce73",
    });
  });

  it("maps known places and fallback places to stable bounded coordinates", () => {
    expect(coordinatesForPlace("Los Angeles")).toEqual({ lat: 34.0522, lon: -118.2437 });
    const first = coordinatesForPlace("My private studio");
    const second = coordinatesForPlace("My private studio");
    expect(first).toEqual(second);
    expect(first.lat).toBeGreaterThanOrEqual(-70);
    expect(first.lat).toBeLessThanOrEqual(70);
    expect(first.lon).toBeGreaterThanOrEqual(-180);
    expect(first.lon).toBeLessThanOrEqual(180);
  });
});

describe("personal moment session storage", () => {
  it("round-trips valid moments and ignores malformed records", () => {
    const storage = createStorage();
    expect(savePersonalMoments([moment], storage)).toBe(true);
    expect(loadPersonalMoments(storage)).toEqual([moment]);

    const malformed = createStorage(JSON.stringify([{ nope: true }, moment]));
    expect(loadPersonalMoments(malformed)).toEqual([moment]);
  });

  it("falls back safely when session storage is unavailable", () => {
    const storage = createStorage(null, true);
    expect(loadPersonalMoments(storage)).toEqual([]);
    expect(savePersonalMoments([moment], storage)).toBe(false);
  });

  it("drops stale document-scoped blob URLs after a reload", () => {
    const stale = createStorage(JSON.stringify([
      { ...moment, imageUrl: "blob:personal-001" },
    ]));
    expect(loadPersonalMoments(stale)).toEqual([]);
  });
});
