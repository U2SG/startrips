export type MultipartPart = {
  partNumber: number;
  etag: string;
};

export type SignedUploadPart = {
  url: string;
  headers?: Record<string, string>;
  expiresAt: Date;
};

export interface MultipartStorage {
  readonly driver: string;

  startMultipartUpload(input: {
    key: string;
    mimeType: string;
    bytes: number;
  }): Promise<{ providerUploadId: string }>;

  signUploadPart(input: {
    key: string;
    providerUploadId: string;
    partNumber: number;
    bytes: number;
  }): Promise<SignedUploadPart>;

  completeMultipartUpload(input: {
    key: string;
    providerUploadId: string;
    parts: MultipartPart[];
    bytes: number;
  }): Promise<void>;

  abortMultipartUpload(input: {
    key: string;
    providerUploadId: string;
  }): Promise<void>;

  /**
   * #260: a presigned write for one whole small object.
   *
   * A derived preview is bounded by `MEDIA_PREVIEW_MAX_BYTES` and is always a
   * single object, so it has no use for a multipart session, its lease or its
   * reconciliation. The size it will actually carry is measured afterwards
   * with `inspectObject` rather than promised here, because a presigned PUT
   * cannot bind one.
   */
  signObjectUpload(input: {
    key: string;
    mimeType: string;
    expiresInSeconds: number;
  }): Promise<SignedUploadPart>;

  deleteObject(input: {
    key: string;
  }): Promise<void>;

  inspectObject(input: {
    key: string;
  }): Promise<{ exists: false } | { exists: true; bytes: number }>;

  createPrivateReadUrl(input: {
    key: string;
    expiresInSeconds: number;
  }): Promise<{ url: string; expiresAt: Date }>;
}

export class StorageUnavailableError extends Error {
  constructor(message = "Object storage is not configured") {
    super(message);
  }
}

export class CompletedObjectIntegrityError extends Error {
  constructor(message = "Completed object does not match the upload record") {
    super(message);
  }
}
