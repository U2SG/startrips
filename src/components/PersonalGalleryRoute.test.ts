import { describe, expect, it } from "vitest";
import type { PersonalMoment } from "../experience/types";
import { buildPersonalGalleryItems } from "./PersonalGalleryRoute";
import { getFullResolutionWindowIndices } from "../../templates/personal-gallery/HangingGallery";

const moments: PersonalMoment[] = [
  {
    id: "personal-001",
    title: "kobe with gianna.",
    note: "我记忆深刻的瞬间",
    year: "2020",
    place: "洛杉矶",
    imageUrl: "/qa/upload-filled-artwork.jpg",
    previewUrl: "/qa/upload-filled-artwork.jpg",
    point: { lat: 34.0522, lon: -118.2437 },
  },
];

describe("buildPersonalGalleryItems", () => {
  it("maps only personal moments into the extracted gallery contract", () => {
    expect(buildPersonalGalleryItems(moments)).toEqual([
      {
        id: "personal-001",
        title: "kobe with gianna.",
        date: "洛杉矶 · 2020",
        imageUrl: "/qa/upload-filled-artwork.jpg",
        previewUrl: "/qa/upload-filled-artwork.jpg",
      },
    ]);
  });

  it("returns an empty gallery for an empty private session", () => {
    expect(buildPersonalGalleryItems([])).toEqual([]);
  });
});

describe("gallery full-resolution budget", () => {
  it("keeps only the selected work and immediate neighbors", () => {
    expect(getFullResolutionWindowIndices(12, 0)).toEqual([0, 1]);
    expect(getFullResolutionWindowIndices(12, 5)).toEqual([4, 5, 6]);
    expect(getFullResolutionWindowIndices(12, 11)).toEqual([10, 11]);
  });
});
