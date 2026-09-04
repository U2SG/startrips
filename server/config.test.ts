import { describe, expect, it } from "vitest";
import { loadServerConfig } from "./config";

const productionEnvironment = {
  NODE_ENV: "production",
  APP_ORIGIN: "https://startrips.example",
  DATABASE_URL: "postgresql://startrips:test@postgres:5432/startrips",
  DATABASE_SSL: "false",
  BETTER_AUTH_SECRET: "x".repeat(32),
  SMTP_URL: "smtp://mailpit:1025",
  MAIL_FROM: "Startrips <no-reply@startrips.example>",
};

describe("S3-compatible storage configuration", () => {
  it("does not require bucket credentials while storage is disabled", () => {
    expect(loadServerConfig({
      ...productionEnvironment,
      STORAGE_DRIVER: "disabled",
    }).storageDriver).toBe("disabled");
  });

  it("rejects an unknown storage driver during startup", () => {
    expect(() => loadServerConfig({
      ...productionEnvironment,
      STORAGE_DRIVER: "cos",
    })).toThrow('STORAGE_DRIVER "cos" is not installed');
  });

  it("requires the portable S3 credential boundary when enabled", () => {
    expect(() => loadServerConfig({
      ...productionEnvironment,
      STORAGE_DRIVER: "s3",
    })).toThrow(
      "S3_BACKEND_ID, S3_REGION, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY required",
    );
  });

  it("accepts a secure custom endpoint without provider-specific fields", () => {
    const config = loadServerConfig({
      ...productionEnvironment,
      STORAGE_DRIVER: "s3",
      S3_BACKEND_ID: "primary-media-v1",
      S3_ENDPOINT: "https://cos.ap-guangzhou.myqcloud.com/",
      S3_KEY_PREFIX: "/live/",
      S3_REGION: "ap-guangzhou",
      S3_BUCKET: "private-atlas-1234567890",
      S3_ACCESS_KEY_ID: "access-key",
      S3_SECRET_ACCESS_KEY: "secret-key",
    });

    expect(config.s3Endpoint).toBe(
      "https://cos.ap-guangzhou.myqcloud.com",
    );
    expect(config.s3BackendId).toBe("primary-media-v1");
    expect(config.s3KeyPrefix).toBe("live");
    expect(config.s3ForcePathStyle).toBe(false);
    expect(config.s3UploadPartExpiresInSeconds).toBe(900);
  });

  it("rejects an insecure production endpoint", () => {
    expect(() => loadServerConfig({
      ...productionEnvironment,
      STORAGE_DRIVER: "s3",
      S3_BACKEND_ID: "primary-media-v1",
      S3_ENDPOINT: "http://minio.internal:9000",
      S3_REGION: "local",
      S3_BUCKET: "private-atlas",
      S3_ACCESS_KEY_ID: "access-key",
      S3_SECRET_ACCESS_KEY: "secret-key",
    })).toThrow("S3_ENDPOINT must use HTTPS in production");
  });

  it("requires a stable non-driver backend identity", () => {
    expect(() => loadServerConfig({
      ...productionEnvironment,
      STORAGE_DRIVER: "s3",
      S3_BACKEND_ID: "s3",
      S3_REGION: "ap-guangzhou",
      S3_BUCKET: "private-atlas",
      S3_ACCESS_KEY_ID: "access-key",
      S3_SECRET_ACCESS_KEY: "secret-key",
    })).toThrow("S3_BACKEND_ID must be a stable lowercase identifier");
  });

  it("rejects traversal-like storage prefixes", () => {
    expect(() => loadServerConfig({
      ...productionEnvironment,
      STORAGE_DRIVER: "disabled",
      S3_BACKEND_ID: "primary-media-v1",
      S3_REGION: "ap-guangzhou",
      S3_BUCKET: "private-atlas",
      S3_ACCESS_KEY_ID: "access-key",
      S3_SECRET_ACCESS_KEY: "secret-key",
      S3_KEY_PREFIX: "live/../private",
    })).toThrow("S3_KEY_PREFIX must contain normal non-empty path segments");
  });
});

describe("media read URL configuration", () => {
  it("defaults the media read URL lifetime to 15 minutes", () => {
    const config = loadServerConfig(productionEnvironment);
    expect(config.mediaReadUrlExpiresInSeconds).toBe(900);
  });

  it("accepts an explicit media read URL lifetime", () => {
    const config = loadServerConfig({
      ...productionEnvironment,
      MEDIA_READ_URL_EXPIRES_IN_SECONDS: "600",
    });
    expect(config.mediaReadUrlExpiresInSeconds).toBe(600);
  });

  it("rejects invalid media read URL lifetimes", () => {
    expect(() => loadServerConfig({
      ...productionEnvironment,
      MEDIA_READ_URL_EXPIRES_IN_SECONDS: "30",
    })).toThrow(
      "MEDIA_READ_URL_EXPIRES_IN_SECONDS must be between 60 and 3600",
    );
  });
});
