/** Startrips-owned recipes. Provider commands and credentials never come from a job. */
const definitions = [
  {
    id: "ink-wash-memory", version: 1, generationKind: "ink-wash-poster",
    title: "水墨记忆",
    artDirection: "Distill the source into broad ink masses, broken dry-brush edges and generous negative space. Derive the palette and structural axes from the source. Do not invent scenery, people, signs or narrative facts.",
    marks: "ink masses and restrained pigment",
  },
  {
    id: "poetic-line-memory", version: 1, generationKind: "poetic-line-memory",
    title: "线条记忆",
    artDirection: "Reconstruct two to four observable spatial relationships with broad charcoal sweeps and one continuous source-derived color gesture. Keep the composition sparse. No stock symbols, tracing, invented scenery or decorative text.",
    marks: "charcoal sweeps and a single color gesture",
  },
  {
    id: "paper-collage-memory", version: 1, generationKind: "paper-collage-memory",
    title: "纸上记忆",
    artDirection: "Distill source subjects into a small set of cut-paper masses with source-derived color, scale and overlap. Preserve the source's focal hierarchy. No travel stickers, invented props, labels or stock landmarks.",
    marks: "layered cut-paper masses",
  },
];

export function listCreativeCoverRecipes() {
  return structuredClone(definitions);
}

export function resolveCreativeCoverRecipe(generationKind, generationVersion) {
  const recipe = definitions.find((item) => item.generationKind === generationKind);
  if (!recipe || generationVersion !== recipe.version) {
    throw new Error("CREATIVE_RECIPE_UNSUPPORTED");
  }
  return structuredClone(recipe);
}

/** Accept the existing worker's stdin contract, not an arbitrary prompt or executable. */
export function buildCreativeCoverTask(request, sourceSha256) {
  if (!request || request.contractVersion !== 1) throw new Error("CREATIVE_CONTRACT_UNSUPPORTED");
  const recipe = resolveCreativeCoverRecipe(request.generationKind, request.generationVersion);
  if (!/^[a-f0-9]{64}$/.test(sourceSha256)) throw new Error("CREATIVE_SOURCE_HASH_INVALID");
  if (request.mimeType !== "image/jpeg") throw new Error("CREATIVE_OUTPUT_MIME_UNSUPPORTED");
  for (const name of ["maxBytes", "maxEdgePixels"]) {
    if (!Number.isSafeInteger(request[name]) || request[name] <= 0) {
      throw new Error("CREATIVE_OUTPUT_LIMIT_INVALID");
    }
  }
  if (typeof request.presetId !== "string" || !request.presetId.trim()
    || typeof request.seed !== "string" || !request.seed.trim()) {
    throw new Error("CREATIVE_RENDER_PIN_MISSING");
  }
  return {
    contractVersion: 1,
    recipe,
    source: { sha256: sourceSha256, contentReference: "sourcePath", overwrite: false },
    output: { mimeType: request.mimeType, maxBytes: request.maxBytes, maxEdgePixels: request.maxEdgePixels },
    renderer: { presetId: request.presetId, seed: request.seed },
    direction: {
      sourceFacts: "Identify three to six visible facts, then record two to four fact-to-mark correspondences.",
      art: recipe.artDirection,
      composition: "Create an opening image in the source aspect ratio, not a framed poster or two-panel zine. Preserve focal placement. Add no text, dates, coordinates or watermark.",
      sourceProtection: "Read the original only. Deliver a separate JPEG opening image. The renderer must end on the unchanged original photograph.",
    },
    // Intent is data for a renderer, not executable animation or a segmentation claim.
    motionIntent: { camera: "locked", subjectMotion: "none", energy: "gentle", finalFrame: "original" },
    review: { required: ["sourceCorrespondence", "composition", "identity", "noInventedContent"], mode: "separate-reviewer" },
  };
}

/** A review is about these exact bytes and recipe, not a previous generation. */
export function assertCreativeCoverReview(review, task, outputSha256) {
  if (!review || review.verdict !== "pass"
    || review.recipeId !== task.recipe.id || review.recipeVersion !== task.recipe.version
    || review.sourceSha256 !== task.source.sha256 || review.outputSha256 !== outputSha256
    || !Array.isArray(review.factToMark) || review.factToMark.length < 2 || review.factToMark.length > 4
    || review.factToMark.some((item) => !item || typeof item.fact !== "string" || !item.fact.trim()
      || typeof item.mark !== "string" || !item.mark.trim())
    || task.review.required.some((key) => review.checks?.[key] !== true)) {
    throw new Error("CREATIVE_VISUAL_REVIEW_REQUIRED");
  }
}
