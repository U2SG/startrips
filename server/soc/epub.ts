import path from "node:path";
import type { Readable } from "node:stream";
import { fromBuffer, type Entry, type ZipFile } from "yauzl";
import { DomUtils, Parser, parseDocument } from "htmlparser2";
import { SocError } from "./files";

const invalid = () => new SocError(400, "STUDY_EPUB_INVALID", "EPUB 文件损坏或不受支持，请换一个文件");
const oversized = () => new SocError(413, "STUDY_EPUB_TOO_LARGE", "EPUB 解压内容过大，请拆分教材");
const MAX_ENTRY = 8 * 1024 * 1024;
const MAX_TEXT = 24 * 1024 * 1024;

function archivePath(value: string) {
  if (!value || value.startsWith("/") || /[\\:\x00-\x1f]/.test(value)
    || value.split("/").some((part) => part === ".." || part === ".")) throw invalid();
  return value;
}

function xmlElements(source: string, localName: string) {
  if (/<!ENTITY/i.test(source)) throw invalid();
  const document = parseDocument(source, { xmlMode: true, decodeEntities: true });
  return DomUtils.findAll((node) => node.name.split(":").pop() === localName, document.children);
}

function chapterText(source: string) {
  let text = "", hidden = 0;
  const skipped = new Set(["head", "script", "style", "svg", "math"]);
  const block = /^(p|div|br|h[1-6]|li|section|article|tr|blockquote)$/;
  const parser = new Parser({
    onopentag(name) { if (skipped.has(name)) hidden++; if (!hidden && block.test(name)) text += "\n"; },
    ontext(value) { if (!hidden) text += value; },
    onclosetag(name) { if (skipped.has(name)) hidden = Math.max(0, hidden - 1); if (!hidden && block.test(name)) text += "\n"; },
  }, { decodeEntities: true });
  parser.end(source);
  return text.replace(/[\t \u00a0]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Read only bounded entries in memory; never extract archive paths to disk. */
export async function readEpub(bytes: Buffer): Promise<string[]> {
  let zip: ZipFile | undefined;
  try {
    zip = await new Promise<ZipFile>((resolve, reject) => fromBuffer(bytes, { lazyEntries: true, autoClose: false, validateEntrySizes: true, strictFileNames: true }, (error, result) => error ? reject(error) : resolve(result!)));
    const archive = zip;
    const entries = new Map<string, Entry>();
    await new Promise<void>((resolve, reject) => {
      let total = 0;
      const onError = (error: Error) => reject(error);
      archive.on("error", onError);
      archive.on("entry", (entry: Entry) => {
        try {
          archivePath(entry.fileName);
          if (entries.has(entry.fileName) || (entry.generalPurposeBitFlag & 1)) throw invalid();
          total += entry.uncompressedSize;
          if (entries.size >= 5000 || total > 256 * 1024 * 1024) throw oversized();
          entries.set(entry.fileName, entry);
          archive.readEntry();
        } catch (error) { reject(error); }
      });
      archive.once("end", () => { archive.off("error", onError); resolve(); });
      archive.readEntry();
    });
    let readBytes = 0;
    async function read(name: string) {
      const entry = entries.get(archivePath(name));
      if (!entry) throw invalid();
      if (entry.uncompressedSize > MAX_ENTRY || readBytes + entry.uncompressedSize > MAX_TEXT) throw oversized();
      const stream = await new Promise<Readable>((resolve, reject) => archive.openReadStream(entry, (error, value) => error ? reject(error) : resolve(value!)));
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const raw of stream) {
        const chunk = Buffer.from(raw);
        size += chunk.length; readBytes += chunk.length;
        if (size > MAX_ENTRY || readBytes > MAX_TEXT) { stream.destroy(); throw oversized(); }
        chunks.push(chunk);
      }
      return Buffer.concat(chunks).toString("utf8");
    }
    if ((await read("mimetype")).trim() !== "application/epub+zip") throw invalid();
    const root = xmlElements(await read("META-INF/container.xml"), "rootfile")[0]?.attribs["full-path"];
    if (!root) throw invalid();
    const packagePath = archivePath(root);
    const manifest = await read(packagePath);
    const items = new Map(xmlElements(manifest, "item").map((item) => [item.attribs.id, item.attribs]));
    const spine = xmlElements(manifest, "itemref").filter((item) => item.attribs.linear !== "no");
    if (!spine.length || spine.length > 1500) throw invalid();
    const encrypted = entries.has("META-INF/encryption.xml")
      ? new Set(xmlElements(await read("META-INF/encryption.xml"), "CipherReference").map((item) => item.attribs.URI)) : new Set<string>();
    const pages: string[] = [];
    for (const reference of spine) {
      const item = items.get(reference.attribs.idref);
      if (!item || !["application/xhtml+xml", "text/html"].includes(item["media-type"])) throw invalid();
      const href = decodeURIComponent(item.href.split("#")[0]);
      // Parent references are legal inside EPUB, but cannot escape its root.
      if (/^(?:[a-z][a-z0-9+.-]*:|\/)/i.test(href) || href.includes("\\")) throw invalid();
      const name = archivePath(path.posix.join(path.posix.dirname(packagePath), href));
      if (encrypted.has(name)) throw new SocError(400, "STUDY_EPUB_DRM", "不支持加密或带 DRM 的 EPUB，请使用无加密版本");
      const text = chapterText(await read(name));
      for (let offset = 0; offset < text.length;) {
        const target = Math.min(offset + 2200, text.length);
        const boundary = target < text.length ? text.lastIndexOf("\n", target) : target;
        const end = boundary > offset + 1100 ? boundary : target;
        pages.push(text.slice(offset, end).trim()); offset = end;
        if (pages.length > 1500) throw oversized();
      }
    }
    if (!pages.some((page) => page.trim())) throw new SocError(400, "STUDY_TEXT_EMPTY", "教材没有可读取的文字，请使用文字版教材");
    return pages;
  } catch (error) {
    if (error instanceof SocError) throw error;
    throw invalid();
  } finally { zip?.close(); }
}
