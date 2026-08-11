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
  }): Promise<void>;

  abortMultipartUpload(input: {
    key: string;
    providerUploadId: string;
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
