import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  COMPOSER_CAPABILITIES,
  COMPOSER_CAPABILITY_IDS,
  COMPOSER_MOBILE_TASKS,
  COMPOSER_SECONDARY_TASKS,
  COMPOSER_TASK_ATTRIBUTE,
  COMPOSER_TASK_ENTRY_ATTRIBUTE,
  composerAvailableHeight,
  composerCapabilitiesForTask,
  composerHeightPosture,
  COMPOSER_CONSTRAINED_HEIGHT,
  composerTask,
  type ComposerCapabilityId,
} from "./composerMobileTasks";

/**
 * #375 acceptance 1: the capability map is published before implementation and
 * every compact state names a discoverable entry and return - "nothing is
 * merely hidden". These tests are what makes that checkable instead of a claim
 * in a PR body.
 */

/**
 * The capabilities the Composer actually implements, written out independently
 * of the map. A capability added to the component and not placed in the map -
 * or placed in the map and quietly dropped from the component - fails here.
 */
const IMPLEMENTED_CAPABILITIES: readonly ComposerCapabilityId[] = [
  "journey-title",
  "journey-dates",
  "journey-note",
  "place-search",
  "record-lookup",
  "route-point-list",
  "route-point-reorder",
  "route-point-remove",
  "route-point-rename",
  "route-point-note",
  "route-point-stop",
  "route-point-media-upload",
  "media-upload",
  "media-assignment",
  "media-order",
  "media-remove",
  "light-color",
  "light-effect",
  "manual-coordinates",
  "globe-pick",
  "save",
  "save-progress",
  "save-media-retry",
  "playback-preview",
  "close-composer",
];

describe("#375 composer mobile capability map", () => {
  it("places every implemented capability exactly once", () => {
    expect([...COMPOSER_CAPABILITY_IDS].sort()).toEqual([...IMPLEMENTED_CAPABILITIES].sort());
    expect(new Set(IMPLEMENTED_CAPABILITIES).size).toBe(IMPLEMENTED_CAPABILITIES.length);
  });

  it("gives every capability a discoverable entry and a return", () => {
    for (const id of COMPOSER_CAPABILITY_IDS) {
      const placement = COMPOSER_CAPABILITIES[id];
      expect(placement.label.trim(), `${id} has no product label`).not.toBe("");
      expect(placement.entry.trim(), `${id} is merely hidden: no entry`).not.toBe("");
      expect(placement.returnTo.trim(), `${id} has no return path`).not.toBe("");
    }
  });

  it("keeps the primary surface to the few controls the owner approved", () => {
    // Journey title, the Route Point list and its record work, add/search, and
    // the sticky save family. Anything else on the primary surface would be the
    // dense settings form the owner ruled out.
    expect(composerCapabilitiesForTask("primary").sort()).toEqual([
      "close-composer",
      "journey-title",
      "place-search",
      "playback-preview",
      "record-lookup",
      "route-point-list",
      "route-point-media-upload",
      "route-point-note",
      "route-point-remove",
      "route-point-rename",
      "route-point-reorder",
      "route-point-stop",
      "save",
      "save-media-retry",
      "save-progress",
    ]);
  });

  it("matches the approved placement for every non-primary capability", () => {
    expect(composerCapabilitiesForTask("journey-info").sort()).toEqual(["journey-dates", "journey-note"]);
    expect(composerCapabilitiesForTask("media").sort()).toEqual([
      "media-assignment",
      "media-order",
      "media-remove",
      "media-upload",
    ]);
    expect(composerCapabilitiesForTask("appearance").sort()).toEqual(["light-color", "light-effect"]);
    expect(composerCapabilitiesForTask("location").sort()).toEqual(["globe-pick", "manual-coordinates"]);
  });

  it("keeps media out of the top level and bound to a Route Point or the media task", () => {
    // The owner's decision: media is not a separate top-level Composer section.
    expect(COMPOSER_CAPABILITIES["route-point-media-upload"].tier).toBe("contextual");
    expect(COMPOSER_CAPABILITIES["route-point-media-upload"].entry).toContain("记录行");
    for (const id of composerCapabilitiesForTask("media")) {
      expect(COMPOSER_CAPABILITIES[id].tier).toBe("secondary");
    }
  });

  it("routes only the deliberate More capabilities behind More", () => {
    for (const id of COMPOSER_CAPABILITY_IDS) {
      const placement = COMPOSER_CAPABILITIES[id];
      expect(composerTask(placement.task).behindMore, `${id} is behind the wrong path`)
        .toBe(placement.tier === "more");
    }
  });

  it("returns every secondary task to the primary surface", () => {
    for (const id of COMPOSER_SECONDARY_TASKS) {
      const task = composerTask(id);
      expect(task.heading.trim(), `${id} has no panel heading to focus`).not.toBe("");
      expect(task.entryLabel.trim(), `${id} has no entry control`).not.toBe("");
      // A task nobody can reach is the same defect as a hidden capability.
      expect(composerCapabilitiesForTask(id).length, `${id} owns no capability`).toBeGreaterThan(0);
    }
    expect(composerTask("primary").behindMore).toBe(false);
  });

  it("is the single source the component renders from", () => {
    const source = readFileSync("src/journey/JourneyComposer.tsx", "utf8");
    expect(source).toContain('from "./composerMobileTasks"');
    expect(source).toContain(`${COMPOSER_TASK_ATTRIBUTE}=`);
    expect(source).toContain(`${COMPOSER_TASK_ENTRY_ATTRIBUTE}=`);
    // Each secondary task must be rendered and enterable by its own id.
    for (const id of COMPOSER_SECONDARY_TASKS) {
      expect(source, `${id} has no panel in the component`).toContain(`"${id}"`);
    }
    // No stylesheet may restate the compact breakpoint for the new layout:
    // the task layout keys off the marker the composer already publishes.
    const css = readFileSync("src/styles/living-atlas.css", "utf8");
    expect(css).toContain('.journey-composer[data-mobile-layout="true"]');
  });
});

describe("#375 composer keyboard available height", () => {
  it("keeps the dialog at its own size when no keyboard takes space", () => {
    expect(composerAvailableHeight(844, 844)).toBeNull();
    expect(composerAvailableHeight(844, 900)).toBeNull();
    expect(composerAvailableHeight(844, null)).toBeNull();
  });

  it("pins the dialog to the visual viewport while the keyboard is open", () => {
    expect(composerAvailableHeight(844, 504)).toBe(504);
    expect(composerAvailableHeight(844, 504, 40)).toBe(464);
  });

  it("never publishes a zero or negative height", () => {
    expect(composerAvailableHeight(844, 40, 40)).toBeNull();
    expect(composerAvailableHeight(844, 20, 90)).toBeNull();
    expect(composerAvailableHeight(0, 400)).toBeNull();
    expect(composerAvailableHeight(Number.NaN, 400)).toBeNull();
  });
});

describe("#375 composer task list", () => {
  it("names the primary surface first and every task once", () => {
    expect(COMPOSER_MOBILE_TASKS[0].id).toBe("primary");
    const ids = COMPOSER_MOBILE_TASKS.map((task) => task.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(COMPOSER_SECONDARY_TASKS).toEqual(ids.slice(1));
  });
});

describe("#375 composer posture", () => {
  it("keeps the normal posture when there is room for the chrome", () => {
    expect(composerHeightPosture(null)).toBeNull();
    expect(composerHeightPosture(844)).toBeNull();
    expect(composerHeightPosture(COMPOSER_CONSTRAINED_HEIGHT + 1)).toBeNull();
  });

  it("collapses the decorative header when the keyboard leaves too little room", () => {
    // A phone in landscape with the keyboard open: a 98px header plus a 78px
    // action bar would leave no room for the field being typed in.
    expect(composerHeightPosture(198)).toBe("constrained");
    expect(composerHeightPosture(COMPOSER_CONSTRAINED_HEIGHT)).toBe("constrained");
  });
});
