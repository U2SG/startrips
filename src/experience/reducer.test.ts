import { afterEach, describe, expect, it, vi } from "vitest";
import { createInitialExperienceState, experienceReducer } from "./reducer";
import { hydrateQaState } from "./qaState";

describe("experienceReducer", () => {
  it("moves from Earth into the archive and artwork detail", () => {
    let state = createInitialExperienceState();
    state = experienceReducer(state, { type: "ENTER_ARCHIVE" });
    expect(state.phase).toBe("archive");
    expect(state.globeMode).toBe("archiveBurst");

    state = experienceReducer(state, { type: "OPEN_ARTWORK_BROWSER" });
    expect(state.phase).toBe("artworkBrowser");
    expect(state.selectedArtworkId).toBe("china-han-dancer");

    state = experienceReducer(state, {
      type: "SELECT_ARTWORK",
      artworkId: "china-han-lacquer-box",
    });
    expect(state.selectedArtworkId).toBe("china-han-lacquer-box");

    state = experienceReducer(state, {
      type: "OPEN_ARTWORK",
      artworkId: "china-han-lacquer-box",
    });
    expect(state.phase).toBe("artworkDetail");
    expect(state.selectedArtworkId).toBe("china-han-lacquer-box");

    state = experienceReducer(state, { type: "CLOSE_ARTWORK" });
    state = experienceReducer(state, { type: "CLOSE_ARTWORK_BROWSER" });
    expect(state.phase).toBe("archive");
    expect(state.globeMode).toBe("archiveBurst");
  });

  it("creates a personal point and returns to the focused Earth", () => {
    let state = createInitialExperienceState();
    state = experienceReducer(state, { type: "START_UPLOAD" });
    state = experienceReducer(state, { type: "SUBMIT_UPLOAD" });
    expect(state.phase).toBe("generating");

    state = experienceReducer(state, {
      type: "POINT_PLACED",
      moment: {
        id: "personal-001",
        title: "Kobe with Gianna",
        year: "2020",
        place: "Los Angeles",
        imageUrl: "/qa/kobe-with-gianna.jpg",
        point: { lat: 34.0522, lon: -118.2437 },
      },
    });
    expect(state.phase).toBe("pointPlaced");
    expect(state.focusedPoint).toEqual({ lat: 34.0522, lon: -118.2437 });

    state = experienceReducer(state, { type: "RETURN_TO_EARTH" });
    expect(state.phase).toBe("earthReturn");
    expect(state.globeMode).toBe("focusPoint");
  });

  it("opens and closes a personal moment without losing it", () => {
    let state = hydrateQaState("earth-return");
    state = experienceReducer(state, { type: "OPEN_PERSONAL_GALLERY" });
    expect(state.phase).toBe("personalGallery");

    state = experienceReducer(state, { type: "OPEN_MOMENT", momentId: "qa-personal-001" });
    expect(state.phase).toBe("momentDetail");
    expect(state.selectedMomentId).toBe("qa-personal-001");

    state = experienceReducer(state, { type: "CLOSE_MOMENT" });
    expect(state.phase).toBe("personalGallery");
    expect(state.personalMoments).toHaveLength(1);

    state = experienceReducer(state, { type: "BACK_TO_EARTH" });
    expect(state.phase).toBe("earthReturn");
    expect(state.focusedPoint).toEqual({ lat: 0, lon: -135 });
    expect(state.personalMoments).toHaveLength(1);
  });

  it("caps personal moments at the gallery capacity", () => {
    let state = createInitialExperienceState();
    for (let index = 0; index < 13; index += 1) {
      state = experienceReducer(state, {
        type: "POINT_PLACED",
        moment: {
          id: `personal-${index}`,
          title: `Moment ${index}`,
          year: "2026",
          place: "Studio",
          imageUrl: `blob:personal-${index}`,
          previewUrl: `blob:personal-${index}-preview`,
          lightColor: "#f4ce73",
          point: { lat: index, lon: index },
        },
      });
    }

    expect(state.personalMoments).toHaveLength(12);
    expect(state.personalMoments[0].id).toBe("personal-12");
    expect(state.personalMoments.some((moment) => moment.id === "personal-0")).toBe(false);
  });
});

describe("hydrateQaState", () => {
  afterEach(() => {
    Reflect.deleteProperty(globalThis, "sessionStorage");
  });

  it("hydrates deterministic upload metadata without browser storage", () => {
    const setItem = vi.fn();
    Object.defineProperty(globalThis, "sessionStorage", {
      configurable: true,
      value: { setItem },
    });
    const state = hydrateQaState("upload-ready");

    expect(state.phase).toBe("upload");
    expect(state.uploadDraft).toMatchObject({
      title: "kobe with gianna.",
      year: "2020",
      place: "洛杉矶",
    });
    expect(setItem).not.toHaveBeenCalled();
  });

  it("hydrates stable gallery and moment detail states", () => {
    const gallery = hydrateQaState("personal-gallery");
    const detail = hydrateQaState("moment-detail");

    expect(gallery.phase).toBe("personalGallery");
    expect(gallery.personalMoments).toHaveLength(1);
    expect(detail.phase).toBe("momentDetail");
    expect(detail.selectedMomentId).toBe("qa-personal-001");
  });
});
