import {
  StorageUnavailableError,
  type MultipartStorage,
} from "./multipart-storage";

function unavailable(): never {
  throw new StorageUnavailableError();
}

export const disabledStorage: MultipartStorage = {
  driver: "disabled",
  async startMultipartUpload() {
    return unavailable();
  },
  async signUploadPart() {
    return unavailable();
  },
  async completeMultipartUpload() {
    return unavailable();
  },
  async abortMultipartUpload() {
    return unavailable();
  },
  async signObjectUpload() {
    return unavailable();
  },
  async deleteObject() {
    return unavailable();
  },
  async listObjects() {
    return unavailable();
  },
  /**
   * #265: no placeholder bytes and no fake success.
   *
   * A read that answered `{ exists: false }` here would be indistinguishable
   * from an object that genuinely never landed, and completion treats that as
   * retryable — so a deployment with no object storage would sit a preview in
   * `pending` forever instead of saying it has nowhere to read from.
   */
  async readObjectHead() {
    return unavailable();
  },
  async inspectObject() {
    return unavailable();
  },
  async createPrivateReadUrl() {
    return unavailable();
  },
};
