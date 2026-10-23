import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { keyboardInset } from "./useKeyboardInset";

const app = readFileSync("src/journey/LivingAtlasApp.tsx", "utf8");
const story = readFileSync("src/journey/JourneyStory.tsx", "utf8");
const css = readFileSync("src/styles/living-atlas.css", "utf8");

function ruleOf(selector: string) {
  const start = css.indexOf(`${selector} {`);
  expect(start, selector).toBeGreaterThan(0);
  return css.slice(start, css.indexOf("}", start));
}

describe("keyboardInset", () => {
  it("measures how far the soft keyboard reaches up from the layout bottom", () => {
    expect(keyboardInset(844, 844, 0)).toBe(0);
    expect(keyboardInset(844, 508, 0)).toBe(336);
    // iOS scrolls the visual viewport down while it is shrunk.
    expect(keyboardInset(844, 508, 120)).toBe(216);
    expect(keyboardInset(844, 900, 0)).toBe(0);
    expect(keyboardInset(390, 189.6, 0)).toBe(200);
  });
});

describe("compact mobile command dock", () => {
  it("moves 记录新旅程 out of the header into the left of the dock row", () => {
    const header = app.slice(app.indexOf('<header className="mobile-v2__header">'), app.indexOf("</header>", app.indexOf('<header className="mobile-v2__header">')));
    expect(header).not.toContain('aria-label="记录新旅程"');
    expect(header).toContain("<MobileAccountActionSlot />");
    const dock = app.slice(app.indexOf('<div className="mobile-v2__dock"'));
    const create = dock.indexOf('className="mobile-v2__dock-create"');
    const chip = dock.indexOf('className="mobile-v2__journey-chip"');
    const field = dock.indexOf('variant="dock"');
    expect(create).toBeGreaterThan(0);
    expect(chip).toBeGreaterThan(create);
    expect(field).toBeGreaterThan(chip);
    expect(dock.slice(create, chip)).toContain('aria-label="记录新旅程"');
  });

  it("puts the time row above the dock row", () => {
    const section = app.slice(app.indexOf('className="mobile-v2__chrome"'));
    expect(section.indexOf('className="mobile-v2__timeline"'))
      .toBeLessThan(section.indexOf('className="mobile-v2__dock"'));
  });

  it("reads router capabilities on mobile and never offers the field to read-only views", () => {
    expect(app).toContain("const commandBarEligible = mutations !== null && !isReadOnlyAtlasView(capabilities);");
    expect(app).toContain("const commandDockLive = isMobileV2 && commandBarVisible && !globePickActive && !playbackActive;");
    // One field at a time: the Atlas dock yields while a Story carries its own.
    expect(app).toMatch(/atlasCommandDockLive = commandDockLive && commandSurface === "atlas"\s+&& storyJourneyId === null/);
    expect(app).toContain("const storyCommandDock = commandDockLive && storyJourneyId !== null ? (");
    // Without the router the dock still holds 记录新旅程 and the Journey chip;
    // with no Journey yet the empty hero owns the band instead.
    expect(app).toMatch(/mobileDockShown = isMobileV2 && view === "planet" && journeys.length > 0\s+&&\(Boolean\(mobileJourney\) \|\| canCreateJourney \|\| atlasCommandDockLive\)/);
  });

  it("lets the Story place its own dock, folded to a pill in the photo-first classic view", () => {
    expect(story).toContain("const commandDockShown = Boolean(commandDock) && mobileLayout && !fullscreen && !mobileManageMode;");
    expect(story).toContain('const commandDockPill = classicActive && mobileClassicView === "photo";');
    // A sibling of the sheet inside the Story layer, never inside the sheet's
    // scroller, and never a key on the Story (the cover must not replay).
    const article = story.indexOf("</article>");
    expect(story.indexOf("<StoryCommandDock", article)).toBeGreaterThan(article);
    expect(app).toContain("commandDock={storyCommandDock}");
  });

  it("keeps the dock field at 16px with 44px targets and the card above the dock", () => {
    expect(ruleOf(".command-bar--dock .command-bar__input")).toContain("font-size: 16px;");
    expect(ruleOf(".command-bar--dock .command-bar__input")).toContain("min-height: var(--mobile-control-hit-size, 44px);");
    expect(ruleOf(".mobile-v2__dock-create")).toContain("width: var(--mobile-control-hit-size, 44px);");
    expect(ruleOf(".story-command-dock__pill")).toContain("min-height: var(--mobile-control-hit-size, 44px);");
    const float = ruleOf(".command-bar__float");
    expect(float).toContain("bottom: calc(100% + var(--mobile-surface-gap, 8px));");
    expect(float).toContain("var(--mobile-keyboard-inset, 0px)");
    expect(ruleOf(".story-command-dock")).toContain("env(safe-area-inset-bottom, 0px)");
  });
});
