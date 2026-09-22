import { Hono } from "hono";
import { requireAtlasAccess } from "../authorization/atlas-access";
import { serverConfig } from "../config";
import type { PreviewCeilings } from "../media/preview-derivation";
import {
  parseMoveMediaInput,
  parseReorderInput,
  parseStartUpload,
  parseUndoMediaMoveInput,
  parseUndoMoveMediaInput,
  readPreviewRequest,
} from "../media/upload-protocol";
import { deleteMediaAssetForAtlas } from "../services/delete-media";
import {
  findAssetForAtlas,
  moveJourneyMediaForAtlas,
  reorderJourneyMediaForAtlas,
  signPrivateMediaRead,
  undoCrossJourneyMediaMoveForAtlas,
  undoJourneyMediaMoveForAtlas,
} from "../services/journey-media";
import { beginAssetPreview, completeAssetPreview } from "../services/media-preview";
import {
  abortUploadForAtlas,
  completeUploadForAtlas,
  signUploadPartForAtlas,
  startUploadForAtlas,
} from "../services/multipart-uploads";
import { readJsonObject } from "./json-body";

export const uploadRoutes = new Hono();

uploadRoutes.post("/start", async (context) => {
  const { atlas, session } = await requireAtlasAccess(context.req.raw, "create");
  const body = await readJsonObject(() => context.req.json());
  const input = body && parseStartUpload(body);
  if (!input) {
    return context.json({ error: "INVALID_UPLOAD" }, 400);
  }

  const result = await startUploadForAtlas(atlas.id, session.user.id, input);
  return context.json(result.body, result.status);
});

uploadRoutes.post("/:id/parts/:partNumber", async (context) => {
  const { atlas } = await requireAtlasAccess(context.req.raw, "create");
  const result = await signUploadPartForAtlas(
    atlas.id,
    context.req.param("id"),
    context.req.param("partNumber"),
  );
  return context.json(result.body, result.status);
});

uploadRoutes.post("/:id/complete", async (context) => {
  const { atlas } = await requireAtlasAccess(context.req.raw, "create");
  const result = await completeUploadForAtlas(
    atlas.id,
    context.req.param("id"),
    () => readJsonObject(() => context.req.json()),
  );
  return context.json(result.body, result.status);
});

uploadRoutes.delete("/:id", async (context) => {
  const { atlas } = await requireAtlasAccess(context.req.raw, "create");
  const result = await abortUploadForAtlas(atlas.id, context.req.param("id"));
  if (result) return context.json(result.body, result.status);
  return context.body(null, 204);
});

function previewCeilings(): PreviewCeilings {
  return {
    maxEdgePixels: serverConfig.mediaPreviewMaxEdgePixels,
    maxBytes: serverConfig.mediaPreviewMaxBytes,
  };
}

/** #260 step 1: plan the preview and sign a write for exactly that plan. */
uploadRoutes.post("/assets/:id/preview", async (context) => {
  const { atlas } = await requireAtlasAccess(context.req.raw, "update");
  const asset = await findAssetForAtlas(context.req.param("id"), atlas.id);
  if (!asset) return context.json({ error: "MEDIA_NOT_FOUND" }, 404);

  const values = readPreviewRequest(await context.req.json().catch(() => null));
  if (!values) return context.json({ error: "INVALID_PREVIEW_REQUEST" }, 400);

  const result = await beginAssetPreview(
    asset,
    values,
    previewCeilings(),
    serverConfig.mediaPreviewUploadExpiresInSeconds,
  );
  if (!result.ok) {
    return context.json({ error: result.error }, result.status);
  }
  return context.json({ upload: result.upload, preview: result.preview });
});

/** #260 step 2: measure what was written, then make it servable — or not. */
uploadRoutes.post("/assets/:id/preview/complete", async (context) => {
  const { atlas } = await requireAtlasAccess(context.req.raw, "update");
  const asset = await findAssetForAtlas(context.req.param("id"), atlas.id);
  if (!asset) return context.json({ error: "MEDIA_NOT_FOUND" }, 404);

  const result = await completeAssetPreview(asset, previewCeilings());
  if (!result.ok) {
    return context.json({ error: result.error }, result.status);
  }
  return context.json({ preview: result.preview });
});

uploadRoutes.get("/assets/:id/read-url", async (context) => {
  const { atlas } = await requireAtlasAccess(context.req.raw, "read");
  const asset = await findAssetForAtlas(context.req.param("id"), atlas.id);
  if (!asset) return context.json({ error: "MEDIA_NOT_FOUND" }, 404);

  return context.json(await signPrivateMediaRead(
    asset,
    serverConfig.mediaReadUrlExpiresInSeconds,
  ));
});

uploadRoutes.delete("/assets/:id", async (context) => {
  const { atlas } = await requireAtlasAccess(context.req.raw, "update");
  const deleted = await deleteMediaAssetForAtlas(
    context.req.param("id"),
    atlas.id,
  );
  if (!deleted) return context.json({ error: "MEDIA_NOT_FOUND" }, 404);
  return context.body(null, 204);
});

uploadRoutes.post("/assets/reorder", async (context) => {
  const { atlas } = await requireAtlasAccess(context.req.raw, "update");
  const body = await readJsonObject(() => context.req.json());
  const input = body && parseReorderInput(body);
  if (!input) {
    return context.json(
      { error: "INVALID_MEDIA_ORDER", message: "Invalid media order" },
      400,
    );
  }

  const result = await reorderJourneyMediaForAtlas(atlas.id, input);
  return context.json(result.body, result.status);
});

uploadRoutes.post("/assets/move", async (context) => {
  const { atlas } = await requireAtlasAccess(context.req.raw, "update");
  const body = await readJsonObject(() => context.req.json());
  const input = body && parseMoveMediaInput(body);
  if (!input) {
    return context.json(
      { error: "INVALID_MEDIA_MOVE", message: "Invalid media move" },
      400,
    );
  }

  const result = await moveJourneyMediaForAtlas(atlas.id, input);
  return context.json(result.body, result.status);
});

uploadRoutes.post("/assets/move/undo", async (context) => {
  const { atlas } = await requireAtlasAccess(context.req.raw, "update");
  const body = await readJsonObject(() => context.req.json());
  const input = body && parseUndoMediaMoveInput(body);
  if (!input) {
    const sameJourneyInput = body && parseUndoMoveMediaInput(body);
    if (!sameJourneyInput) {
      return context.json(
        { error: "INVALID_MEDIA_MOVE_UNDO", message: "Invalid media move undo" },
        400,
      );
    }
    const result = await undoJourneyMediaMoveForAtlas(atlas.id, sameJourneyInput);
    return context.json(result.body, result.status);
  }

  const result = await undoCrossJourneyMediaMoveForAtlas(atlas.id, input);
  return context.json(result.body, result.status);
});
