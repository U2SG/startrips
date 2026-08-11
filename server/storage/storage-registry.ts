import { serverConfig } from "../config";
import { disabledStorage } from "./disabled-storage";
import {
  StorageUnavailableError,
  type MultipartStorage,
} from "./multipart-storage";

const storageDrivers: Record<string, MultipartStorage> = {
  disabled: disabledStorage,
};

export function getMultipartStorage(
  driver = serverConfig.storageDriver,
): MultipartStorage {
  const storage = storageDrivers[driver];
  if (!storage) {
    throw new StorageUnavailableError(
      `Storage driver "${driver}" is not installed`,
    );
  }
  return storage;
}
