import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { buildCreativeCoverTask, listCreativeCoverRecipes } from "./creative-cover-recipes.mjs";
import { executeCreativeCover } from "./creative-cover-adapter.mjs";
import { createOpenAICreativeProvider, creativeProviderConfig } from "./creative-cover-openai.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const structured = (value) => ({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(value) }] }] });
const review = { verdict: "pass", checks: { sourceCorrespondence: true, composition: true, identity: true, noInventedContent: true },
  factToMark: [{ fact: "large central shape", mark: "central pigment mass" }, { fact: "warm background", mark: "warm paper" }] };
async function fixture(run) {
  const dir = await mkdtemp(path.join(tmpdir(), "creative-provider-"));
  const bytes = await sharp({ create: { width: 96, height: 64, channels: 3, background: "#d8bf91" } }).jpeg().toBuffer();
  const sourcePath = path.join(dir, "source.jpg"), outputPath = path.join(dir, "output.jpg");
  await writeFile(sourcePath, bytes);
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith("images/edits")) return Response.json({ data: [{ b64_json: bytes.toString("base64") }] });
    const body = JSON.parse(init.body);
    return Response.json(structured(body.text.format.name === "source_facts" ? { facts: ["large central shape", "warm background", "horizontal canvas"] } : review));
  };
  const config = creativeProviderConfig({ OPENAI_API_KEY: "fixture-only", STARTRIPS_CREATIVE_IMAGE_MODEL: "gpt-image-2", STARTRIPS_CREATIVE_REVIEW_MODEL: "review-fixture" });
  try { await run({ dir, bytes, sourcePath, outputPath, calls, fetcher, config }); }
  finally { await rm(dir, { recursive: true, force: true }); }
}
describe("built-in creative provider contract (mocked provider, real JPEG decoder)", () => {
  it.each(listCreativeCoverRecipes())("runs $id through analysis, editing, separate review and publication", async (recipe) => fixture(async ({ sourcePath, outputPath, bytes, fetcher, config, calls }) => {
    const request = { contractVersion: 1, sourcePath, outputPath, generationKind: recipe.generationKind, generationVersion: 1,
      mimeType: "image/jpeg", maxBytes: 1000000, maxEdgePixels: 1024, presetId: recipe.presetId, seed: "fixture" };
    const provider = createOpenAICreativeProvider(config, { fetcher });
    await executeCreativeCover(request, { ...provider, validateImage: async (image) => sharp(image).metadata() });
    expect(calls.map((call) => call.url.split("/").pop())).toEqual(["responses", "edits", "responses"]);
    expect(JSON.parse(calls[0].init.body).store).toBe(false);
    expect(JSON.parse(calls[2].init.body).store).toBe(false);
    expect(calls[1].init.body.get("model")).toBe("gpt-image-2");
    expect(calls[1].init.body.get("prompt")).toContain(recipe.artDirection);
    expect(calls[1].init.body.has("input_fidelity")).toBe(false);
    expect(await readFile(sourcePath)).toEqual(bytes);
    const dimensions = await sharp(await readFile(outputPath)).metadata();
    expect([dimensions.width, dimensions.height]).toEqual([96, 64]);
  }));
  it("does not publish a rejected review and does not retry paid generation", async () => fixture(async ({ dir, sourcePath, outputPath, fetcher, config }) => {
    let edits = 0;
    const failReview = async (url, init) => {
      if (url.endsWith("images/edits")) edits++;
      if (typeof init.body === "string" && JSON.parse(init.body).text.format.name === "cover_review") return Response.json(structured({ ...review, verdict: "fail" }));
      return fetcher(url, init);
    };
    await expect(executeCreativeCover({ contractVersion: 1, sourcePath, outputPath, generationKind: "ink-wash-poster", generationVersion: 1,
      mimeType: "image/jpeg", maxBytes: 1000000, maxEdgePixels: 1024, presetId: "reveal-flow-ink-wash-v1", seed: "fixture" }, {
        ...createOpenAICreativeProvider(config, { fetcher: failReview }), validateImage: async (image) => sharp(image).metadata(),
      })).rejects.toThrow("CREATIVE_VISUAL_REVIEW_REQUIRED");
    expect(edits).toBe(1); expect(await readdir(dir)).toEqual(["source.jpg"]);
  }));
  it("fails incomplete/refused analysis before requesting image generation", async () => fixture(async ({ sourcePath, outputPath, bytes, config }) => {
    let requests = 0;
    const provider = createOpenAICreativeProvider(config, { fetcher: async () => { requests++; return Response.json({ status: "incomplete", output: [] }); } });
    const task = buildCreativeCoverTask({ contractVersion: 1, generationKind: "ink-wash-poster", generationVersion: 1,
      mimeType: "image/jpeg", maxBytes: 1000000, maxEdgePixels: 1024, presetId: "reveal-flow-ink-wash-v1", seed: "fixture" }, hash(bytes));
    await expect(provider.generate({ ...task, sourcePath, outputPath })).rejects.toThrow("INCOMPLETE");
    expect(requests).toBe(1);
  }));
  it("requires a key without forwarding provider-supplied errors", () => {
    expect(() => creativeProviderConfig({})).toThrow("KEY_REQUIRED");
  });
  it("rejects non-raster bytes before decoding or sending them to the provider", async () => fixture(async ({ sourcePath, outputPath, config }) => {
    const markup = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><text>not a JPEG</text></svg>');
    await writeFile(sourcePath, markup);
    let requests = 0;
    const provider = createOpenAICreativeProvider(config, { fetcher: async () => { requests++; throw new Error("must not send markup"); } });
    const task = buildCreativeCoverTask({ contractVersion: 1, generationKind: "ink-wash-poster", generationVersion: 1,
      mimeType: "image/jpeg", maxBytes: 1000000, maxEdgePixels: 1024, presetId: "reveal-flow-ink-wash-v1", seed: "fixture" }, hash(markup));
    await expect(provider.generate({ ...task, sourcePath, outputPath })).rejects.toThrow("CREATIVE_SOURCE_NOT_RASTER");
    expect(requests).toBe(0);
  }));

});
