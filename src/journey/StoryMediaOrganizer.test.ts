import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StoryMediaOrganizer } from "./StoryMediaOrganizer";
import type { JourneyMediaAsset } from "./types";

const sortableState = vi.hoisted(() => ({ overId: null as string | null }));

vi.mock("@dnd-kit/sortable", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@dnd-kit/sortable")>();
  return {
    ...actual,
    useSortable: ({ id }: { id: string }) => ({
      setNodeRef: () => undefined,
      setActivatorNodeRef: () => undefined,
      attributes: {},
      listeners: undefined,
      transform: null,
      transition: undefined,
      isDragging: false,
      isOver: sortableState.overId === id,
    }),
  };
});

const media: JourneyMediaAsset[] = ["asset-a", "asset-b"].map((id, sortOrder) => ({
  id,
  journeyId: "journey-1",
  routePointId: null,
  storageDriver: "test",
  storageKey: id,
  fileName: `${id}.png`,
  mimeType: "image/png",
  bytes: 1,
  sortOrder,
  uploadedByUserId: "user-1",
  createdAt: "2026-09-26T00:00:00.000Z",
}));

function renderTiles() {
  const markup = renderToStaticMarkup(createElement(StoryMediaOrganizer, {
    media,
    allMedia: media,
    routePoints: [],
    reads: {},
    currentId: null,
    coverId: null,
    selectedIds: new Set<string>(),
    selecting: false,
    disabled: false,
    onToggleSelect: () => undefined,
    onSelect: () => undefined,
    onRequestRead: () => undefined,
    onReorder: () => undefined,
    onMove: async () => true,
  }));
  const tiles = [...markup.matchAll(/<li\b[^>]*>/g)].map(([tag]) => tag);
  expect(tiles).toHaveLength(2);
  return { markup, tile: (id: string) => tiles.find((tag) => tag.includes(`data-media-tile-id="${id}"`)) };
}

afterEach(() => { sortableState.overId = null; });

describe("Story media sortable drag-over target", () => {
  it("marks only the item currently under the drag, separately from destination hover", () => {
    const idle = renderTiles();
    expect(idle.tile("asset-a")).not.toContain('data-drag-over="true"');
    expect(idle.tile("asset-b")).not.toContain('data-drag-over="true"');

    sortableState.overId = "asset-b";
    const overB = renderTiles();
    expect(overB.tile("asset-a")).not.toContain('data-drag-over="true"');
    expect(overB.tile("asset-b")).toContain('data-drag-over="true"');
    expect(overB.markup).not.toContain("story-media-organizer__destination is-over");

    sortableState.overId = "asset-a";
    const overA = renderTiles();
    expect(overA.tile("asset-a")).toContain('data-drag-over="true"');
    expect(overA.tile("asset-b")).not.toContain('data-drag-over="true"');
  });
});
