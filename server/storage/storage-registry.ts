import { serverConfig } from "../config";
import { disabledStorage } from "./disabled-storage";
import {
  StorageUnavailableError,
  type MultipartStorage,
} from "./multipart-storage";
import { createS3CompatibleStorage } from "./s3-compatible-storage";

let s3Storage: MultipartStorage | undefined;

export function hasConfiguredStorageBackends() {
  return Boolean(
    serverConfig.s3BackendId
    && serverConfig.s3Region
    && serverConfig.s3Bucket
    && serverConfig.s3AccessKeyId
    && serverConfig.s3SecretAccessKey,
  );
}

function getS3Storage() {
  if (s3Storage) return s3Storage;
  if (
    !serverConfig.s3BackendId
    || !serverConfig.s3Region
    || !serverConfig.s3Bucket
    || !serverConfig.s3AccessKeyId
    || !serverConfig.s3SecretAccessKey
  ) {
    throw new StorageUnavailableError(
      "S3-compatible object storage is not fully configured",
    );
  }
  s3Storage = createS3CompatibleStorage({
    backendId: serverConfig.s3BackendId,
    endpoint: serverConfig.s3Endpoint,
    keyPrefix: serverConfig.s3KeyPrefix,
    region: serverConfig.s3Region,
    bucket: serverConfig.s3Bucket,
    accessKeyId: serverConfig.s3AccessKeyId,
    secretAccessKey: serverConfig.s3SecretAccessKey,
    sessionToken: serverConfig.s3SessionToken,
    forcePathStyle: serverConfig.s3ForcePathStyle,
    uploadPartExpiresInSeconds: serverConfig.s3UploadPartExpiresInSeconds,
  });
  return s3Storage;
}

export function getMultipartStorage(
  backendId?: string,
): MultipartStorage {
  if (backendId === undefined) {
    if (serverConfig.storageDriver === "disabled") return disabledStorage;
    if (serverConfig.storageDriver === "s3") return getS3Storage();
    throw new StorageUnavailableError(
      `Storage driver "${serverConfig.storageDriver}" is not installed`,
    );
  }
  if (backendId === "disabled") return disabledStorage;
  if (backendId === serverConfig.s3BackendId) return getS3Storage();
  throw new StorageUnavailableError(
    `Storage backend "${backendId}" is not installed`,
  );
}
