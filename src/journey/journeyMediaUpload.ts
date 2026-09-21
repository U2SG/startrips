import { uploadMediaInParts, type UploadedMediaAsset } from "../api/multipartUpload";

export type UploadProgress = {
  fileName: string;
  uploadedBytes: number;
  totalBytes: number;
};

export type JourneyMediaUploadAssignment = {
  file: File;
  routePointId?: string;
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
};

type UploadJourneyMediaOptions = Omit<UploadJourneyMediaAssignmentsOptions, "assignments"> & {
  routePointId?: string;
  files: readonly File[];
};

export async function uploadJourneyMediaAssignments({
  journeyId,
  assignments,
  upload = uploadMediaInParts,
  onProgress,
}: UploadJourneyMediaAssignmentsOptions): Promise<JourneyMediaUploadResult> {
  const totalBytes = assignments.reduce((sum, assignment) => sum + assignment.file.size, 0);
  const mediaErrors: JourneyMediaUploadResult["mediaErrors"] = [];
  const assets: UploadedMediaAsset[] = [];
  let uploadedCount = 0;
  let completedBytes = 0;

  for (let fileIndex = 0; fileIndex < assignments.length; fileIndex += 1) {
    const { file, routePointId } = assignments[fileIndex];
    try {
      const asset = await upload({
        file,
        fileName: file.name,
        journeyId,
        routePointId,
        concurrency: 2,
        onProgress: ({ uploadedBytes }) => onProgress?.({
          fileName: file.name,
          uploadedBytes: completedBytes + uploadedBytes,
          totalBytes,
        }),
      });
      if (asset) assets.push(asset);
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
  upload,
  onProgress,
}: UploadJourneyMediaOptions): Promise<JourneyMediaUploadResult> {
  return uploadJourneyMediaAssignments({
    journeyId,
    assignments: files.map((file) => ({ file, routePointId })),
    upload,
    onProgress,
  });
}
