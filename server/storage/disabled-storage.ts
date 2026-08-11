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
  async inspectObject() {
    return unavailable();
  },
  async createPrivateReadUrl() {
    return unavailable();
  },
};
