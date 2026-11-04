import { uploadMediaInParts, type UploadedMediaAsset } from "../api/multipartUpload";
import type { MediaRecordedEvidenceDocument } from "./types";

export type UploadProgress = {
  fileName: string;
  uploadedBytes: number;
  totalBytes: number;
};

export type JourneyMediaUploadAssignment = {
  file: File;
  routePointId?: string;
  recordedEvidence?: MediaRecordedEvidenceDocument;
};

export type JourneyMediaUploadResult = {
  uploadedCount: number;
  mediaErrors: Array<{ fileIndex: number; fileName: string; message: string }>;
  // The server can return an existing asset for duplicate content. Preserve its
  // resolved id and upload order so callers can select the completed media.
  assets: UploadedMediaAsset[];
};

type UploadJourneyMediaAssignmentsOptions = {
  journeyId: string;
  assignments: readonly JourneyMediaUploadAssignment[];
  upload?: typeof uploadMediaInParts;
  onProgress?: (progress: UploadProgress) => void;
  signal?: AbortSignal;
  onAssetConfirmed?: (confirmation: { fileIndex: number; asset: UploadedMediaAsset }) => void;
};

type UploadJourneyMediaOptions = Omit<UploadJourneyMediaAssignmentsOptions, "assignments"> & {
  routePointId?: string;
  files: readonly File[];
  recordedEvidenceByFile?: readonly (MediaRecordedEvidenceDocument | undefined)[];
};

export async function uploadJourneyMediaAssignments({
  journeyId,
  assignments,
  upload = uploadMediaInParts,
  onProgress,
  signal,
  onAssetConfirmed,
}: UploadJourneyMediaAssignmentsOptions): Promise<JourneyMediaUploadResult> {
  const totalBytes = assignments.reduce((sum, assignment) => sum + assignment.file.size, 0);
  const mediaErrors: JourneyMediaUploadResult["mediaErrors"] = [];
  const assets: UploadedMediaAsset[] = [];
  let uploadedCount = 0;
  let completedBytes = 0;

  for (let fileIndex = 0; fileIndex < assignments.length; fileIndex += 1) {
    if (signal?.aborted) break; // Never start another file after its owner left.
    const { file, routePointId, recordedEvidence } = assignments[fileIndex];
    let confirmed = false;
    const confirm = (asset: UploadedMediaAsset) => {
      if (confirmed || !asset?.id || asset.journeyId !== journeyId) return;
      confirmed = true;
      onAssetConfirmed?.({ fileIndex, asset });
    };
    try {
      const asset = await upload({
        file,
        fileName: file.name,
        journeyId,
        routePointId,
        recordedEvidence,
        concurrency: 2,
        signal,
        onAssetConfirmed: confirm,
        onProgress: ({ uploadedBytes }) => onProgress?.({
          fileName: file.name,
          uploadedBytes: completedBytes + uploadedBytes,
          totalBytes,
        }),
      });
      if (asset) {
        confirm(asset);
        assets.push(asset);
      }
      uploadedCount += 1;
    } catch (error) {
      mediaErrors.push({
        fileIndex,
        fileName: file.name,
        message: error instanceof Error ? error.message : "上传失败",
      });
    } finally {
      completedBytes += file.size;
      onProgress?.({
        fileName: file.name,
        uploadedBytes: completedBytes,
        totalBytes,
      });
    }
  }

  return { uploadedCount, mediaErrors, assets };
}

export async function uploadJourneyMedia({
  journeyId,
  routePointId,
  files,
  recordedEvidenceByFile,
  upload,
  onProgress,
  signal,
  onAssetConfirmed,
}: UploadJourneyMediaOptions): Promise<JourneyMediaUploadResult> {
  return uploadJourneyMediaAssignments({
    journeyId,
    assignments: files.map((file, index) => ({
      file,
      routePointId,
      recordedEvidence: recordedEvidenceByFile?.[index],
    })),
    upload,
    onProgress,
    signal,
    onAssetConfirmed,
  });
}
