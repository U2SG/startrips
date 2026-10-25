import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { SocFiles } from "./files";
import { extractStudyPdf } from "./pdf";

function textbookPdf() {
  const text = "BT /F1 12 Tf 24 48 Td (Hello Soc) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += "xref\n0 6\n0000000000 65535 f \n";
  pdf += offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  pdf += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}

it("extracts real PDF page text and reuses its private page cache", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "startrips-soc-pdf-"));
  try {
    const files = new SocFiles(root, "reader");
    const file = "project-data/books/test/source.pdf";
    await files.write(file, textbookPdf(), null, true);
    const result = await extractStudyPdf(files, file, 1, 1);
    expect(result).toEqual({ numPages: 1, pages: [{ page: 1, text: "Hello Soc" }] });
    expect(JSON.parse((await files.read("project-data/books/test/pages.json")).toString()).sourceSig).toMatch(/^[a-f0-9]{64}$/);
    expect(await extractStudyPdf(files, file, 1, 1)).toEqual(result);
  } finally { await rm(root, { recursive: true, force: true }); }
});
