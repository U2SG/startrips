import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { readEpub } from "./epub";
import { epubFixture } from "./epub.fixture";
import { SocFiles } from "./files";
import { importTextbook } from "./import";
import { extractStudyPdf } from "./pdf";

it("reads EPUB spine order, decodes entities and excludes executable/hidden markup", async () => {
  const pages = await readEpub(epubFixture());
  expect(pages).toEqual(["第二章先读", "第一章\n理解 & 推理"]);
});

it("bounds virtual pages for long reflowable EPUB chapters", async () => {
  const pages = await readEpub(epubFixture({ "OPS/two.xhtml": `<html><body><p>${"中".repeat(5000)}</p></body></html>` }));
  expect(pages.slice(0, 3).map((text) => text.length)).toEqual([2200, 2200, 600]);
});

it("refuses traversal, oversized archives, DRM, and malformed or empty books", async () => {
  await expect(readEpub(epubFixture({ "../outside.xhtml": "outside" }))).rejects.toMatchObject({ status: 400 });
  await expect(readEpub(epubFixture({}, { size: 300 * 1024 * 1024 }))).rejects.toBeDefined();
  await expect(readEpub(epubFixture({ "META-INF/encryption.xml": '<encryption><CipherReference URI="OPS/two.xhtml"/></encryption>' }))).rejects.toMatchObject({ code: "STUDY_EPUB_DRM" });
  await expect(readEpub(Buffer.from("not a zip"))).rejects.toMatchObject({ code: "STUDY_EPUB_INVALID" });
  await expect(readEpub(epubFixture({ "OPS/one.xhtml": "<html/>", "OPS/two.xhtml": "<html/>" }))).rejects.toMatchObject({ code: "STUDY_TEXT_EMPTY" });
});

it("registers imported EPUBs, extracts a later lesson window, isolates owners and cleans failed imports", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "soc-import-"));
  try {
    const files = new SocFiles(root, "alice"), other = new SocFiles(root, "bob");
    const world = "project-data/accounts/local/profiles/default/worlds/study";
    await files.write(`${world}/world_meta.json`, Buffer.from('{"worldId":"study"}'), null, true);
    const book = await importTextbook(files, world, "教材.epub", epubFixture());
    expect(book).toMatchObject({ title: "教材", format: "epub", numPages: 2 });
    const source = `${world}/textbooks/${book.id}/source.epub`;
    expect(await extractStudyPdf(files, source, 2, 2)).toEqual({ numPages: 2, pages: [{ page: 2, text: "第一章\n理解 & 推理" }] });
    await expect(other.read(source)).rejects.toMatchObject({ status: 404 });
    await expect(importTextbook(files, world, "坏书.epub", Buffer.from("broken"))).rejects.toMatchObject({ status: 400 });
    const index = JSON.parse((await files.read(`${world}/textbooks/textbook_index.json`)).toString());
    expect(index.textbooks).toHaveLength(1);
    expect((await files.list(`${world}/textbooks`)).filter((entry) => entry.dir)).toHaveLength(1);
  } finally { await rm(root, { recursive: true, force: true }); }
});
