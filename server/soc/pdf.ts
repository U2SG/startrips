import { createHash } from "node:crypto";
import { SocError, type SocFiles } from "./files";
import { readEpub } from "./epub";

let extracting = false;
export async function extractStudyPdf(files: SocFiles, relative: string, start: number, end: number, withSignature = false) {
  const epub = relative.toLowerCase().endsWith(".epub");
  if (!epub && !relative.toLowerCase().endsWith(".pdf")) throw new SocError(400, "STUDY_PDF_REQUIRED", "请选择 PDF 或 EPUB 教材");
  if (extracting) throw new SocError(429, "STUDY_EXTRACTION_BUSY", "正在处理教材，请稍后重试");
  const bytes = await files.read(relative);
  const signature = createHash("sha256").update(bytes).digest("hex");
  const cachePath = relative.replace(/[^/]+$/, "pages.json");
  let cached: { sourceSig: string; numPages: number; pages: string[] } | null = null;
  let oldTag: string | null = null;
  try {
    const { contentTag } = await import("./files");
    const old = await files.read(cachePath);
    oldTag = contentTag(old);
    const candidate = JSON.parse(old.toString("utf8"));
    if (candidate.sourceSig === signature && Array.isArray(candidate.pages)) cached = candidate;
  } catch (error) {
    if (!(error instanceof SyntaxError) && !(error instanceof SocError && error.status === 404)) throw error;
  }
  if (!cached) {
    if (extracting) throw new SocError(429, "STUDY_EXTRACTION_BUSY", "正在处理教材，请稍后重试");
    extracting = true;
    try {
      if (epub) {
        const pages = await readEpub(bytes);
        if (!pages.some((text) => text.trim())) throw new SocError(400, "STUDY_TEXT_EMPTY", "教材没有可读取的文字，请使用文字版教材");
        cached = { sourceSig: signature, numPages: pages.length, pages };
        await files.write(cachePath, Buffer.from(JSON.stringify(cached)), oldTag, !oldTag);
      } else {
        const pdf = await import("pdfjs-dist/legacy/build/pdf.mjs");
        const document = await pdf.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, useSystemFonts: true }).promise;
        try {
          if (document.numPages > 1500) throw new SocError(413, "STUDY_PDF_TOO_LONG", "请把教材拆分为不超过 1500 页的文件");
          const pages: string[] = [];
          for (let number = 1; number <= document.numPages; number++) {
            const page = await document.getPage(number);
            const content = await page.getTextContent();
            let y: number | null = null;
            let text = "";
            for (const item of content.items) {
              if (!("str" in item)) continue;
              const nextY = Math.round(item.transform[5]);
              if (y !== null && Math.abs(nextY - y) > 2) text += "\n";
              text += item.str;
              y = nextY;
            }
            pages.push(text.trim());
            page.cleanup();
          }
          if (!pages.some((text) => text.trim())) throw new SocError(400, "STUDY_TEXT_EMPTY", "教材没有可读取的文字，请使用文字版教材");
          cached = { sourceSig: signature, numPages: pages.length, pages };
          await files.write(cachePath, Buffer.from(JSON.stringify(cached)), oldTag, !oldTag);
        } finally { await document.destroy(); }
      }
    } finally { extracting = false; }
  }
  const first = Math.max(1, start);
  const last = Math.min(cached.numPages, end);
  return { numPages: cached.numPages, pages: cached.pages.slice(first - 1, last).map((text, index) => ({ page: first + index, text })), ...(withSignature ? { sourceSig: signature } : {}) };
}
