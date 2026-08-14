import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  S3Client,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import {
  CompletedObjectIntegrityError,
  type MultipartPart,
  type MultipartStorage,
} from "./multipart-storage";

const DEFAULT_UPLOAD_PART_EXPIRY_SECONDS = 15 * 60;

type SignableCommand = UploadPartCommand | GetObjectCommand;
type SignUrl = (
  client: S3Client,
  command: SignableCommand,
  options: { expiresIn: number },
) => Promise<string>;

export type S3CompatibleStorageOptions = {
  backendId: string;
  bucket: string;
  region: string;
  endpoint?: string | null;
  keyPrefix?: string | null;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string | null;
  forcePathStyle?: boolean;
  uploadPartExpiresInSeconds?: number;
  client?: S3Client;
  signUrl?: SignUrl;
};

function isMissingObject(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const candidate = error as {
    Code?: string;
    code?: string;
    name?: string;
    $metadata?: { httpStatusCode?: number };
  };
  const providerCode = candidate.Code
    ?? candidate.code
    ?? (candidate.name && candidate.name !== "Error" ? candidate.name : null);
  if (providerCode) {
    return providerCode === "NotFound" || providerCode === "NoSuchKey";
  }
  return candidate.$metadata?.httpStatusCode === 404;
}

function isMissingUpload(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const candidate = error as {
    Code?: string;
    code?: string;
    name?: string;
  };
  return candidate.Code === "NoSuchUpload"
    || candidate.code === "NoSuchUpload"
    || candidate.name === "NoSuchUpload";
}

export function createS3CompatibleStorage(
  options: S3CompatibleStorageOptions,
): MultipartStorage {
  const uploadPartExpiresInSeconds =
    options.uploadPartExpiresInSeconds ?? DEFAULT_UPLOAD_PART_EXPIRY_SECONDS;
  const client = options.client ?? new S3Client({
    region: options.region,
    endpoint: options.endpoint || undefined,
    forcePathStyle: options.forcePathStyle ?? false,
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
    credentials: {
      accessKeyId: options.accessKeyId,
      secretAccessKey: options.secretAccessKey,
      ...(options.sessionToken ? { sessionToken: options.sessionToken } : {}),
    },
  });
  const signUrl = options.signUrl ?? (getSignedUrl as SignUrl);
  const keyPrefix = options.keyPrefix?.replace(/^\/+|\/+$/g, "") || "";
  const objectInput = (key: string) => ({
    Bucket: options.bucket,
    Key: keyPrefix ? `${keyPrefix}/${key}` : key,
  });

  return {
    driver: options.backendId,

    async startMultipartUpload(input) {
      if (!Number.isSafeInteger(input.bytes) || input.bytes < 1) {
        throw new Error("Multipart upload size must be a positive integer");
      }
      const result = await client.send(new CreateMultipartUploadCommand({
        ...objectInput(input.key),
        ContentType: input.mimeType,
      }));
      if (!result.UploadId) {
        throw new Error("Object storage did not return a multipart upload ID");
      }
      return { providerUploadId: result.UploadId };
    },

    async signUploadPart(input) {
      if (!Number.isSafeInteger(input.bytes) || input.bytes < 1) {
        throw new Error("Multipart part size must be a positive integer");
      }
      const signedAt = Date.now();
      const url = await signUrl(
        client,
        new UploadPartCommand({
          ...objectInput(input.key),
          UploadId: input.providerUploadId,
          PartNumber: input.partNumber,
          ContentLength: input.bytes,
        }),
        { expiresIn: uploadPartExpiresInSeconds },
      );
      return {
        url,
        expiresAt: new Date(
          signedAt + uploadPartExpiresInSeconds * 1_000,
        ),
      };
    },

    async completeMultipartUpload(input) {
      if (!Number.isSafeInteger(input.bytes) || input.bytes < 1) {
        throw new Error("Completed object size must be a positive integer");
      }
      await client.send(new CompleteMultipartUploadCommand({
        ...objectInput(input.key),
        UploadId: input.providerUploadId,
        MultipartUpload: {
          Parts: input.parts.map((part: MultipartPart) => ({
            ETag: part.etag,
            PartNumber: part.partNumber,
          })),
        },
      }));
      const completed = await client.send(new HeadObjectCommand(
        objectInput(input.key),
      ));
      if (completed.ContentLength !== input.bytes) {
        throw new CompletedObjectIntegrityError(
          "Completed object size does not match the upload record",
        );
      }
    },

    async abortMultipartUpload(input) {
      try {
        await client.send(new AbortMultipartUploadCommand({
          ...objectInput(input.key),
          UploadId: input.providerUploadId,
        }));
      } catch (error) {
        if (!isMissingUpload(error)) throw error;
      }
    },

    async deleteObject(input) {
      await client.send(new DeleteObjectCommand(objectInput(input.key)));
    },

    async inspectObject(input) {
      try {
        const result = await client.send(new HeadObjectCommand(
          objectInput(input.key),
        ));
        if (
          !Number.isSafeInteger(result.ContentLength)
          || (result.ContentLength ?? -1) < 0
        ) {
          throw new Error(
            "Object storage did not return a valid object size",
          );
        }
        return { exists: true, bytes: result.ContentLength as number };
      } catch (error) {
        if (isMissingObject(error)) return { exists: false };
        throw error;
      }
    },

    async createPrivateReadUrl(input) {
      const signedAt = Date.now();
      const url = await signUrl(
        client,
        new GetObjectCommand(objectInput(input.key)),
        { expiresIn: input.expiresInSeconds },
      );
      return {
        url,
        expiresAt: new Date(signedAt + input.expiresInSeconds * 1_000),
      };
    },
  };
}
