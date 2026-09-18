import { Hono, type Context } from "hono";
import { requireAtlasAccess } from "../authorization/atlas-access";
import {
  parseDisplayStateWrite,
  parseRecordedEvidenceWrite,
} from "../media/media-evidence";
import {
  readMediaEvidenceForAtlas,
  writeMediaDisplayStateForAtlas,
  writeRecordedMediaEvidenceForAtlas,
  type MediaEvidenceRecord,
  type MediaEvidenceWriteResult,
} from "../repositories/media-evidence-repository";
import { readJsonObject } from "./json-body";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const MEDIA_EVIDENCE_CACHE_CONTROL = "private, no-store, max-age=0";

function serialize(evidence: MediaEvidenceRecord) {
  return {
    ...evidence,
    recorded: {
      ...evidence.recorded,
      captureTime: {
        ...evidence.recorded.captureTime,
        instant: evidence.recorded.captureTime.instant?.toISOString() ?? null,
      },
    },
    updatedAt: evidence.updatedAt?.toISOString() ?? null,
  };
}

function answer(context: Context, evidence: MediaEvidenceRecord) {
  context.header("Cache-Control", MEDIA_EVIDENCE_CACHE_CONTROL);
  return context.json({ evidence: serialize(evidence) });
}

function answerWrite(
  context: Context,
  result: MediaEvidenceWriteResult,
) {
  if (result.outcome === "asset-missing") {
    return context.json({ error: "MEDIA_ASSET_NOT_FOUND" }, 404);
  }
  if (result.outcome === "conflict") {
    context.header("Cache-Control", MEDIA_EVIDENCE_CACHE_CONTROL);
    return context.json(
      {
        error: "MEDIA_EVIDENCE_REVISION_CONFLICT",
        evidence: serialize(result.evidence),
      },
      409,
    );
  }
  return answer(context, result.evidence);
}

export const mediaEvidenceRoutes = new Hono();

mediaEvidenceRoutes.get("/:assetId", async (context) => {
  const { atlas } = await requireAtlasAccess(context.req.raw, "read");
  const assetId = context.req.param("assetId");
  if (!UUID_PATTERN.test(assetId)) {
    return context.json({ error: "MEDIA_ASSET_NOT_FOUND" }, 404);
  }
  const evidence = await readMediaEvidenceForAtlas(atlas.id, assetId);
  if (!evidence) return context.json({ error: "MEDIA_ASSET_NOT_FOUND" }, 404);
  return answer(context, evidence);
});

mediaEvidenceRoutes.put("/:assetId/recorded", async (context) => {
  const { atlas } = await requireAtlasAccess(context.req.raw, "update");
  const assetId = context.req.param("assetId");
  if (!UUID_PATTERN.test(assetId)) {
    return context.json({ error: "MEDIA_ASSET_NOT_FOUND" }, 404);
  }
  const body = await readJsonObject(() => context.req.json());
  const write = parseRecordedEvidenceWrite(body);
  if (!write) {
    return context.json({ error: "INVALID_MEDIA_RECORDED_EVIDENCE" }, 400);
  }
  return answerWrite(context, await writeRecordedMediaEvidenceForAtlas(
    atlas.id, assetId, write,
  ));
});

mediaEvidenceRoutes.put("/:assetId/display", async (context) => {
  const { atlas } = await requireAtlasAccess(context.req.raw, "update");
  const assetId = context.req.param("assetId");
  if (!UUID_PATTERN.test(assetId)) {
    return context.json({ error: "MEDIA_ASSET_NOT_FOUND" }, 404);
  }
  const body = await readJsonObject(() => context.req.json());
  const write = parseDisplayStateWrite(body);
  if (!write) {
    return context.json({ error: "INVALID_MEDIA_DISPLAY_STATE" }, 400);
  }
  return answerWrite(context, await writeMediaDisplayStateForAtlas(
    atlas.id, assetId, write,
  ));
});
