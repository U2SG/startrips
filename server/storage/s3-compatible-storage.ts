import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
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
/** One page of a prefix listing; the provider's own maximum. */
const LIST_OBJECTS_PAGE_SIZE = 1_000;

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
  /**
   * The inverse of `objectInput`, so a listed key comes back in the terms the
   * database stores it in.
   *
   * `null` means the provider handed back something outside this deployment's
   * namespace. The caller drops it: reporting it unchanged would let a sweep
   * conclude that a key nothing in this application named is unreferenced.
   */
  const stripKeyPrefix = (key: string | undefined): string | null => {
    if (!key) return null;
    if (!keyPrefix) return key;
    const prefixed = `${keyPrefix}/`;
    return key.startsWith(prefixed) ? key.slice(prefixed.length) : null;
  };

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

    async signObjectUpload(input) {
      const signedAt = Date.now();
      const url = await signUrl(
        client,
        new PutObjectCommand({
          ...objectInput(input.key),
          ContentType: input.mimeType,
        }),
        { expiresIn: input.expiresInSeconds },
      );
      return {
        url,
        // The signature covers this header, so a writer that omits or changes
        // it is rejected by the backend rather than storing an object whose
        // type disagrees with what the server planned.
        headers: { "content-type": input.mimeType },
        expiresAt: new Date(signedAt + input.expiresInSeconds * 1_000),
      };
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

    async listObjects(input) {
      const result = await client.send(new ListObjectsV2Command({
        Bucket: options.bucket,
        Prefix: keyPrefix ? `${keyPrefix}/${input.prefix}` : input.prefix,
        ContinuationToken: input.continuationToken,
        MaxKeys: LIST_OBJECTS_PAGE_SIZE,
      }));
      const keys: string[] = [];
      for (const object of result.Contents ?? []) {
        // A key that does not sit under the deployment prefix is not this
        // application's object to name, so it is skipped rather than reported
        // with a mangled name. The provider filtered by the prefixed form, so
        // this only fires if a bucket is shared in a way the adapter did not
        // configure.
        const stripped = stripKeyPrefix(object.Key);
        if (stripped !== null) keys.push(stripped);
      }
      return {
        keys,
        // Present only while the provider says the listing is truncated, so a
        // caller loops on the token's presence and never on a key count.
        ...(result.IsTruncated && result.NextContinuationToken
          ? { continuationToken: result.NextContinuationToken }
          : {}),
      };
    },

    async readObjectHead(input) {
      try {
        const result = await client.send(new GetObjectCommand({
          ...objectInput(input.key),
          // A ranged GET, so the window is enforced by the provider and never
          // travels: an object larger than the caller's bound costs the bound,
          // not its own size. The header is inclusive of both ends, hence the
          // `- 1`. A range past the end of a shorter object is satisfied with
          // whatever it holds rather than refused, which is why a smaller
          // object still reads whole.
          Range: `bytes=0-${input.maxBytes - 1}`,
        }));
        if (!result.Body) {
          throw new Error("Object storage returned an object with no body");
        }
        const bytes = await result.Body.transformToByteArray();
        // The provider is expected to honour the range, but the caller's bound
        // is the contract this returns under, so it is applied here too rather
        // than trusted from the wire.
        return {
          exists: true,
          bytes: bytes.length > input.maxBytes
            ? bytes.subarray(0, input.maxBytes)
            : bytes,
        };
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
