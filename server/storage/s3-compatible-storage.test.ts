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
import { afterEach, describe, expect, it, vi } from "vitest";
import { createS3CompatibleStorage } from "./s3-compatible-storage";

function setup() {
  const send = vi.fn();
  const signUrl = vi.fn();
  const client = { send } as unknown as S3Client;
  const storage = createS3CompatibleStorage({
    backendId: "primary-media-v1",
    bucket: "private-atlas",
    region: "ap-guangzhou",
    endpoint: "https://cos.ap-guangzhou.myqcloud.com",
    keyPrefix: "live",
    accessKeyId: "test-access-key",
    secretAccessKey: "test-secret-key",
    client,
    signUrl,
  });
  return { client, send, signUrl, storage };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("S3-compatible multipart storage", () => {
  it("persists a stable backend identity", () => {
    expect(setup().storage.driver).toBe("primary-media-v1");
  });

  it("starts an upload and preserves the media content type", async () => {
    const { send, storage } = setup();
    send.mockResolvedValue({ UploadId: "provider-upload-1" });

    await expect(storage.startMultipartUpload({
      key: "atlas/journey/object",
      mimeType: "video/mp4",
      bytes: 20_000_000,
    })).resolves.toEqual({ providerUploadId: "provider-upload-1" });

    const command = send.mock.calls[0][0];
    expect(command).toBeInstanceOf(CreateMultipartUploadCommand);
    expect(command.input).toEqual({
      Bucket: "private-atlas",
      Key: "live/atlas/journey/object",
      ContentType: "video/mp4",
    });
  });

  it("signs only the requested part for fifteen minutes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-12T00:00:00.000Z"));
    const { client, signUrl, storage } = setup();
    signUrl.mockResolvedValue("https://upload.example/signed-part");

    await expect(storage.signUploadPart({
      key: "atlas/journey/object",
      providerUploadId: "provider-upload-1",
      partNumber: 2,
      bytes: 8 * 1024 * 1024,
    })).resolves.toEqual({
      url: "https://upload.example/signed-part",
      expiresAt: new Date("2026-08-12T00:15:00.000Z"),
    });

    expect(signUrl).toHaveBeenCalledOnce();
    expect(signUrl.mock.calls[0][0]).toBe(client);
    expect(signUrl.mock.calls[0][2]).toEqual({ expiresIn: 900 });
    const command = signUrl.mock.calls[0][1];
    expect(command).toBeInstanceOf(UploadPartCommand);
    expect(command.input).toEqual({
      Bucket: "private-atlas",
      Key: "live/atlas/journey/object",
      UploadId: "provider-upload-1",
      PartNumber: 2,
      ContentLength: 8 * 1024 * 1024,
    });
  });

  it("includes the expected content length in a real part signature", async () => {
    const storage = createS3CompatibleStorage({
      backendId: "primary-media-v1",
      bucket: "private-atlas",
      region: "ap-guangzhou",
      endpoint: "https://cos.ap-guangzhou.myqcloud.com",
      accessKeyId: "test-access-key",
      secretAccessKey: "test-secret-key",
    });

    const signed = await storage.signUploadPart({
      key: "atlas/journey/object",
      providerUploadId: "provider-upload-1",
      partNumber: 1,
      bytes: 8 * 1024 * 1024,
    });
    const signedHeaders = new URL(signed.url).searchParams
      .get("X-Amz-SignedHeaders")
      ?.split(";");

    expect(signedHeaders).toContain("content-length");
  });

  it("verifies completed size and aborts using opaque provider ETags", async () => {
    const { send, storage } = setup();
    send
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ ContentLength: 16 });
    const parts = [
      { partNumber: 1, etag: "\"opaque-A\"" },
      { partNumber: 2, etag: "OSS-ETAG-B" },
    ];

    await storage.completeMultipartUpload({
      key: "atlas/journey/object",
      providerUploadId: "provider-upload-1",
      parts,
      bytes: 16,
    });
    await storage.abortMultipartUpload({
      key: "atlas/journey/abandoned",
      providerUploadId: "provider-upload-2",
    });

    const complete = send.mock.calls[0][0];
    expect(complete).toBeInstanceOf(CompleteMultipartUploadCommand);
    expect(complete.input.MultipartUpload?.Parts).toEqual([
      { PartNumber: 1, ETag: "\"opaque-A\"" },
      { PartNumber: 2, ETag: "OSS-ETAG-B" },
    ]);
    expect(send.mock.calls[1][0]).toBeInstanceOf(HeadObjectCommand);
    expect(send.mock.calls[2][0]).toBeInstanceOf(
      AbortMultipartUploadCommand,
    );
  });

  it("rejects a completed object with a different size", async () => {
    const { send, storage } = setup();
    send
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ ContentLength: 15 });

    await expect(storage.completeMultipartUpload({
      key: "atlas/journey/object",
      providerUploadId: "provider-upload-1",
      parts: [{ partNumber: 1, etag: "etag" }],
      bytes: 16,
    })).rejects.toThrow("Completed object size does not match");
  });

  it("treats an already missing multipart upload as aborted", async () => {
    const { send, storage } = setup();
    send.mockRejectedValue(Object.assign(new Error("missing"), {
      name: "NoSuchUpload",
      $metadata: { httpStatusCode: 404 },
    }));

    await expect(storage.abortMultipartUpload({
      key: "atlas/journey/expired",
      providerUploadId: "provider-upload-expired",
    })).resolves.toBeUndefined();
  });

  it("does not hide a missing bucket as a missing object or upload", async () => {
    const { send, storage } = setup();
    const missingBucket = Object.assign(new Error("wrong bucket"), {
      Code: "NoSuchBucket",
      $metadata: { httpStatusCode: 404 },
    });
    send.mockRejectedValue(missingBucket);

    await expect(storage.inspectObject({ key: "object" }))
      .rejects.toBe(missingBucket);
    await expect(storage.abortMultipartUpload({
      key: "object",
      providerUploadId: "upload",
    })).rejects.toBe(missingBucket);
  });

  it("deletes a completed orphan by exact key", async () => {
    const { send, storage } = setup();
    send.mockResolvedValue({});

    await storage.deleteObject({ key: "atlas/journey/orphan" });

    const command = send.mock.calls[0][0];
    expect(command).toBeInstanceOf(DeleteObjectCommand);
    expect(command.input).toEqual({
      Bucket: "private-atlas",
      Key: "live/atlas/journey/orphan",
    });
  });

  it("inspects object size, distinguishes 404, and signs private reads", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-12T01:00:00.000Z"));
    const { send, signUrl, storage } = setup();
    send.mockResolvedValueOnce({ ContentLength: 42 });

    await expect(storage.inspectObject({ key: "stored" })).resolves.toEqual({
      exists: true,
      bytes: 42,
    });
    expect(send.mock.calls[0][0]).toBeInstanceOf(HeadObjectCommand);

    send.mockRejectedValueOnce(Object.assign(new Error("missing"), {
      $metadata: { httpStatusCode: 404 },
    }));
    await expect(storage.inspectObject({ key: "missing" })).resolves.toEqual({
      exists: false,
    });

    signUrl.mockResolvedValue("https://media.example/private-read");
    await expect(storage.createPrivateReadUrl({
      key: "stored",
      expiresInSeconds: 300,
    })).resolves.toEqual({
      url: "https://media.example/private-read",
      expiresAt: new Date("2026-08-12T01:05:00.000Z"),
    });
    expect(signUrl.mock.calls[0][1]).toBeInstanceOf(GetObjectCommand);
  });
});
