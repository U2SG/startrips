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

  /**
   * #260: what is actually stored under one prefix, page by page.
   *
   * The lifecycle of a derived preview cannot be reasoned about from records
   * alone. A presigned single-object write is authorised when it STARTS and
   * carries no provider-enforced request lifetime, so a write issued before a
   * Journey was deleted may land after every row that could name its key is
   * gone. Bookkeeping cannot close that: no clock proves an already-running
   * request has finished, and retaining a row per unlanded write forever only
   * moves the leak into Postgres.
   *
   * Enumeration closes it, because it asks storage the one question the whole
   * problem reduces to — what is in there — so an object is retired because
   * nothing references it rather than because an interval elapsed.
   *
   * `keys` are storage keys as the application names them: an adapter that
   * stores under a deployment prefix strips it, so a returned key is directly
   * comparable to `media_assets.preview_storage_key`.
   */
  listObjects(input: {
    prefix: string;
    continuationToken?: string;
  }): Promise<{ keys: string[]; continuationToken?: string }>;

  /**
   * #260: the bytes of one whole small object.
   *
   * Only ever called for an object already measured against
   * `MEDIA_PREVIEW_MAX_BYTES`, so a caller never asks for more than a preview
   * of that size. Reading a preview back is what makes its pixel ceiling a
   * verified property of the object that landed rather than a bound the
   * server asked a producer to respect.
   */
  readObject(input: {
    key: string;
  }): Promise<{ exists: false } | { exists: true; bytes: Uint8Array }>;

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
