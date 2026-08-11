import { describe, expect, it } from "vitest";
import { archiveBrowserRecords } from "../data/archiveRecords";
import { getArchiveNeighbor } from "./ArtworkBrowser";

describe("getArchiveNeighbor", () => {
  it("moves through the archive and wraps without losing the selected record", () => {
    expect(getArchiveNeighbor(archiveBrowserRecords, "china-han-dancer", -1).id).toBe(
      "china-han-lacquer-box",
    );
    expect(getArchiveNeighbor(archiveBrowserRecords, "china-han-dancer", 1).id).toBe(
      "china-eastern-zhou-hu",
    );
    expect(getArchiveNeighbor(archiveBrowserRecords, "china-han-lacquer-box", 1).id).toBe(
      "china-han-dancer",
    );
  });
});
