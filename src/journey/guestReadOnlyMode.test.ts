import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  AtlasViewProvider,
  GUEST_ATLAS_VIEW_CAPABILITIES,
  OWNER_ATLAS_VIEW_CAPABILITIES,
  type AtlasView,
} from "./atlasView";
import { JourneyStory } from "./JourneyStory";
import { sharedAtlasStatusForFailure } from "./sharedAtlas";
import type { Journey } from "./types";

const GUEST_VIEW: AtlasView = {
  capabilities: GUEST_ATLAS_VIEW_CAPABILITIES,
  listJourneys: async () => [],
  readMedia: async () => ({ url: "signed", expiresAt: "2026-09-05T00:01:30.000Z" }),
  mutations: null,
};

const journey: Journey = {
  id: "journey-a",
  atlasId: "",
  title: "海风经过深圳湾",
  startedOn: "2026-08-20",
  endedOn: null,
  note: "路线本身成为这一晚的记忆。",
  lightColor: "#77c8c2",
  lightEffect: null,
  coverMediaAssetId: null,
  revision: 1,
  createdByUserId: "",
  createdAt: "",
  updatedAt: "",
  routePoints: [{
    id: "point-a",
    journeyId: "journey-a",
    sortOrder: 0,
    latitude: 22.5,
    longitude: 114,
    label: "深圳湾",
    isStop: true,
    occurredAt: null,
    note: null,
    createdAt: "",
  }],
  media: [{
    id: "asset-a",
    journeyId: "journey-a",
    routePointId: null,
    storageDriver: "",
    storageKey: "",
    fileName: "sea.jpg",
    mimeType: "image/jpeg",
    bytes: 2048,
    sortOrder: 0,
    uploadedByUserId: "",
    createdAt: "",
  }],
};

function storyMarkup(view: AtlasView | null) {
  const story = createElement(JourneyStory, {
    journeys: [journey],
    journeyId: journey.id,
    onClose: () => undefined,
    onNavigate: () => undefined,
    onMediaAdded: () => null,
    // A guest tree passes no owner callback at all. Before #200 phase D an
    // absent `onMediaDelete` fell through to the owner API client, so this is
    // exactly the shape that used to leave deletion reachable.
    ...(view === null
      ? { onEdit: () => undefined, onDelete: () => undefined, onShare: () => undefined }
      : {}),
  });
  return renderToStaticMarkup(
    view === null ? story : createElement(AtlasViewProvider, { value: view }, story),
  );
}

/**
 * Every mutation affordance the story dialog can render, by its own copy.
 *
 * `删除媒体` and the drag-reorder tiles only render in the compact-mobile
 * branch, which this environment's `matchMedia` never selects, so those two
 * entries are belt-and-braces here. The browser lane asserts the same list at
 * 390x844 and 932x430, where they are the reachable surface.
 */
const MUTATION_AFFORDANCES = [
  "添加照片或视频",
  "编辑旅程",
  "删除旅程",
  // #200 phase E. `canShareAtlas` was declared by phase D and unused until the
  // owner share UI landed; now that it gates a real control, a guest tree that
  // regained it would render a create-link affordance over the owner routes.
  "分享旅程",
  "删除媒体",
  "设为封面",
  "上传配乐",
  "移除配乐",
  "替换配乐",
];

describe("JourneyStory in a read-only capability set (#200 phase D)", () => {
  it("renders no mutation affordance and no file input", () => {
    const markup = storyMarkup(GUEST_VIEW);
    for (const affordance of MUTATION_AFFORDANCES) {
      expect(markup).not.toContain(affordance);
    }
    // A file input is the upload handler's own surface; a hidden one would
    // still be a reachable upload.
    expect(markup).not.toContain('type="file"');
    expect(markup).not.toContain("journey-story__media-add");
    expect(markup).not.toContain("journey-story__media-actions");
  });

  it("still renders the viewing surface a recipient came for", () => {
    const markup = storyMarkup(GUEST_VIEW);
    expect(markup).toContain('role="dialog"');
    expect(markup).toContain('aria-label="退出旅程故事"');
    expect(markup).toContain("海风经过深圳湾");
    expect(markup).toContain("深圳湾");
    // Journey navigation stays; its scope is closed by the payload itself.
    expect(markup).toContain("上一段");
    expect(markup).toContain("下一段");
  });

  it("keeps every one of those affordances in owner mode", () => {
    // The same component, the same props shape, the owner capability set: if
    // this stops holding, the read-only assertions above have become vacuous.
    const ownerMarkup = storyMarkup(null);
    expect(ownerMarkup).toContain('type="file"');
    expect(ownerMarkup).toContain("添加照片或视频");
    expect(ownerMarkup).toContain("编辑旅程");
    expect(ownerMarkup).toContain("删除旅程");
    expect(ownerMarkup).toContain("分享旅程");
    expect(OWNER_ATLAS_VIEW_CAPABILITIES.canManageMedia).toBe(true);
  });
});

/**
 * The guest-reachable modules must not be able to reach the owner API at all.
 *
 * This is a source assertion rather than a behavioural one because the defect
 * it guards against is an import: any one of these modules could re-add
 * `import { deleteMedia } from "./journeyApi"` and quietly restore the
 * fall-through that #200 phase D removed, and no rendered markup would change.
 * `journeyApi` itself and `JourneyComposer` are deliberately absent from this
 * list: the composer IS the owner mutation surface and shared mode never
 * renders it.
 */
const OWNER_MUTATION_EXPORTS = [
  "createJourney",
  "updateJourney",
  "deleteJourney",
  "restoreJourney",
  "deleteMedia",
  "reorderJourneyMedia",
  "moveJourneyMedia",
  "moveMediaBetweenJourneys",
  "undoMediaMove",
  "undoJourneyMediaMove",
  "setJourneyCover",
  "getPrivateMediaRead",
  // #200 phase E: creating and revoking a link are owner writes, and the
  // owner's list of its own links is owner-private. All three reach the UI
  // through `AtlasMutations`, so naming one here would be the same
  // fall-through this list exists to catch.
  "createShare",
  "listShares",
  "revokeShare",
];

const GUEST_REACHABLE_MODULES = [
  "JourneyStory.tsx",
  // Statically imported by `LivingAtlasApp`, so it is in a guest bundle even
  // though a guest can never mount it: its share client arrives as a prop.
  "JourneyShareDialog.tsx",
  "shareLinks.ts",
  "JourneyPlaybackOverlay.tsx",
  "LivingAtlasApp.tsx",
  "JourneyTimeline.tsx",
  "soundtrackReadCache.ts",
  "SharedAtlasView.tsx",
  "sharedAtlas.ts",
];

describe("guest-reachable modules import no owner API client", () => {
  for (const moduleName of GUEST_REACHABLE_MODULES) {
    it(`${moduleName} names no owner mutation or owner media read`, () => {
      const source = readFileSync(new URL(moduleName, import.meta.url), "utf8");
      for (const exportName of OWNER_MUTATION_EXPORTS) {
        expect(source).not.toMatch(
          new RegExp(`(^|[^A-Za-z0-9_.])${exportName}\\s*[,(]`, "m"),
        );
      }
      // `LivingAtlasApp` legitimately imports the composer: it is the owner
      // mutation surface, and the app renders it only when the capability
      // exists. The story dialog and the soundtrack cache must not reach it.
      if (moduleName === "JourneyStory.tsx" || moduleName === "soundtrackReadCache.ts") {
        expect(source).not.toContain('from "./JourneyComposer"');
      }
    });
  }

  it("keeps the owner client in exactly one place", () => {
    const source = readFileSync(new URL("atlasView.ts", import.meta.url), "utf8");
    expect(source).toContain('from "./journeyApi"');
    expect(source).toContain("createOwnerAtlasMutations");
  });
});

describe("sharedAtlasStatusForFailure", () => {
  it("ends the session only for a dead link", () => {
    expect(sharedAtlasStatusForFailure("link-unavailable")).toBe("unavailable");
  });

  it("keeps a live session when one asset is withdrawn", () => {
    // The owner moved a photo out of a shared journey. #200 is explicit that
    // the link still works, so the viewer must not tear itself down.
    expect(sharedAtlasStatusForFailure("media-unavailable")).toBeNull();
  });

  it("keeps a transport failure separate from an expiry", () => {
    expect(sharedAtlasStatusForFailure("network")).toBe("error");
  });
});
