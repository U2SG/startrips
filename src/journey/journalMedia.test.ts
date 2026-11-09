import { expect, it } from "vitest";
import { journalMediaGroups, firstJournalPlaceMediaEvents } from "./journalMedia";
import { previewJournalImport } from "./dailyJournal";
import type { JourneyMediaAsset } from "./types";
const media = [
  { id: "photo", routePointId: "point", mimeType: "image/jpeg" },
  { id: "video", routePointId: "point", mimeType: "video/mp4" },
  { id: "audio", routePointId: "point", mimeType: "audio/mp3" },
  { id: "elsewhere", routePointId: "other", mimeType: "image/jpeg" },
  { id: "unassigned", routePointId: null, mimeType: "image/jpeg" },
] as JourneyMediaAsset[];
it("projects existing point photos and videos, deduplicates manual links and never writes them back", () => {
  const event = previewJournalImport("实际：看花", "2028-06-03")[0].events[0];
  event.routePointId = "point"; event.mediaIds = ["photo", "elsewhere", "deleted"];
  expect(journalMediaGroups(event, media)).toEqual({ manual: ["photo", "elsewhere"], place: ["video"] });
  expect(event.mediaIds).toEqual(["photo", "elsewhere", "deleted"]);
  expect(journalMediaGroups(event, [...media, { ...media[0], id: "new-photo" }]).place).toEqual(["video", "new-photo"]);
  expect(journalMediaGroups(event, media.filter(m => m.id !== "video"))).toEqual({ manual: ["photo", "elsewhere"], place: [] });
});
it("does not inherit media for an unlinked, planned, cancelled or uncertain event", () => {
  const event = previewJournalImport("实际：看花", "2028-06-03")[0].events[0];
  expect(journalMediaGroups(event, media)).toEqual({ manual: [], place: [] });
  for (const status of ["planned", "cancelled", "uncertain"] as const) {
    event.status = status; event.routePointId = "point"; event.mediaIds = ["elsewhere"];
    expect(journalMediaGroups(event, media)).toEqual({ manual: ["elsewhere"], place: [] });
  }
});

it("clearing manual links leaves only separately labeled point context, not event evidence", () => {
  const event = previewJournalImport("实际：看花", "2028-06-03")[0].events[0];
  event.routePointId = "point"; event.mediaIds = ["photo"];
  expect(journalMediaGroups(event, media)).toEqual({ manual: ["photo"], place: ["video"] });
  event.mediaIds = [];
  expect(journalMediaGroups(event, media)).toEqual({ manual: [], place: ["photo", "video"] });
});

it("selects the first visible event for each place gallery, respecting filters and uncertain events", () => {
  const event = previewJournalImport("实际：看花", "2028-06-03")[0].events[0]; event.routePointId = "point";
  const second = { ...event, id: "second" };
  expect([...firstJournalPlaceMediaEvents([event, second], media)]).toEqual([["point", event.id]]);
  expect([...firstJournalPlaceMediaEvents([second], media)]).toEqual([["point", "second"]]);
  expect([...firstJournalPlaceMediaEvents([{ ...event, status: "uncertain" }, second], media)]).toEqual([["point", "second"]]);
});
