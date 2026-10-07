import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The Playback stage hands the media its height through grid rows, and a
 * transit via's media has two shapes: alone (one row) or with a short note
 * riding ahead of it (#595). On the deployed host the second shape rendered
 * only the note: the single-row rule left the media in an implicit 0 px row,
 * while the image still loaded, decoded and committed, so Playback advanced
 * past every noted transit chapter without showing a frame. These checks pin
 * the two shapes to the two row templates.
 */
const starlight = readFileSync("src/styles/starlight-media.css", "utf8");
const overlay = readFileSync("src/journey/JourneyPlaybackOverlay.tsx", "utf8");

function rule(source: string, selector: string): string {
  const start = source.indexOf(selector);
  expect(start, `rule ${selector}`).toBeGreaterThanOrEqual(0);
  const open = source.indexOf("{", start);
  const close = source.indexOf("}", open);
  return source.slice(open + 1, close);
}

describe("Playback transit chapter stage rows", () => {
  it("keeps a transit chapter without a note on the single media row", () => {
    const body = rule(starlight, ".journey-playback__stage:has(> .journey-playback__transit-media) {");
    expect(body).toContain("grid-template-rows: minmax(0, 1fr)");
  });

  it("gives a transit chapter with a note its own capped row above the media", () => {
    const body = rule(
      starlight,
      ".journey-playback__stage:has(> .journey-playback__transit-media > .journey-playback__transit-note)",
    );
    expect(body).toContain("grid-template-rows: fit-content(34%) minmax(0, 1fr)");
    expect(body).toContain("align-content: stretch");
  });

  it("renders the transit note as a direct child of the transit media group, ahead of the media", () => {
    const transit = overlay.indexOf('className="journey-playback__transit-note"');
    const chapterMedia = overlay.indexOf('className="journey-playback__chapter-media"');
    expect(transit).toBeGreaterThan(0);
    expect(transit).toBeLessThan(chapterMedia);
    expect(overlay).toContain("journey-playback__transit-media");
  });
});
