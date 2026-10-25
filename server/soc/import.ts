import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { contentTag, SocError, type SocFiles } from "./files";
import { extractStudyPdf } from "./pdf";

export async function importTextbook(files: SocFiles, world: string, name: string, bytes: Buffer) {
  if (!/^project-data\/accounts\/[^/]+\/profiles\/[^/]+\/worlds\/[^/]+$/.test(world)) throw new SocError(400, "STUDY_WORLD_REQUIRED", "请选择学习世界");
  await files.resolve(world);
  await files.read(`${world}/world_meta.json`);
  const format = name.split(".").pop()?.toLowerCase();
  if (!format || !["pdf", "epub"].includes(format)) throw new SocError(400, "STUDY_BOOK_TYPE", "请选择 PDF 或 EPUB 教材");
  if (!bytes.length) throw new SocError(400, "STUDY_TEXT_EMPTY", "文件为空，请重新选择");
  const id = randomUUID();
  const dir = `${world}/textbooks/${id}`;
  const source = `${dir}/source.${format}`;
  await files.write(source, bytes, null, true);
  try {
    const { numPages, pages } = await extractStudyPdf(files, source, 1, 1);
    if (!numPages || !pages.length) throw new SocError(400, "STUDY_TEXT_EMPTY", "教材没有可读取的内容");
    const textbook = { id, fileName: `source.${format}`, format, title: name.replace(/\.(pdf|epub)$/i, "").slice(0, 200) || "教材", numPages, currentPage: 0 };
    const indexPath = `${world}/textbooks/textbook_index.json`;
    // A file revision protects concurrent imports and progress updates.
    for (let attempt = 0; attempt < 3; attempt++) {
      let old: Buffer | null = null;
      try { old = await files.read(indexPath); } catch (error) { if (!(error instanceof SocError && error.status === 404)) throw error; }
      const index = old ? JSON.parse(old.toString("utf8")) : { worldId: world.split("/").pop(), textbooks: [] };
      index.textbooks.push(textbook); index.updatedAt = new Date().toISOString();
      try { await files.write(indexPath, Buffer.from(JSON.stringify(index)), old ? contentTag(old) : null, !old); return textbook; }
      catch (error) { if (!(error instanceof SocError && error.status === 409) || attempt === 2) throw error; }
    }
    throw new SocError(409, "STUDY_FILE_CHANGED", "教材列表已更新，请重试");
  } catch (error) {
    // Only this request's random, unregistered textbook directory is removed.
    await rm(await files.resolve(dir), { recursive: true, force: true });
    throw error;
  }
}
