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

  // #200 phase C: the guest ceiling is a separate knob with a lower floor, so
  // a deployment can shorten a share link's media lifetime without shortening
  // the owner's.
  it("defaults the share media read URL lifetime to 90 seconds", () => {
    const config = loadServerConfig(productionEnvironment);
    expect(config.shareMediaReadUrlExpiresInSeconds).toBe(90);
  });

  it("accepts an explicit share media read URL lifetime", () => {
    const config = loadServerConfig({
      ...productionEnvironment,
      SHARE_MEDIA_READ_URL_EXPIRES_IN_SECONDS: "45",
    });
    expect(config.shareMediaReadUrlExpiresInSeconds).toBe(45);
  });

  it("rejects share media read URL lifetimes outside 15 to 600 seconds", () => {
    for (const value of ["5", "900", "60.5"]) {
      expect(() => loadServerConfig({
        ...productionEnvironment,
        SHARE_MEDIA_READ_URL_EXPIRES_IN_SECONDS: value,
      })).toThrow(
        "SHARE_MEDIA_READ_URL_EXPIRES_IN_SECONDS must be between 15 and 600",
      );
    }
  });

  // Deliberately allowed: a deployment that shortens the owner lifetime below
  // the guest ceiling is not a startup error. The presign takes the minimum of
  // both, so the guest still never outlives the owner.
  it("accepts a share ceiling above a shortened owner lifetime", () => {
    const config = loadServerConfig({
      ...productionEnvironment,
      MEDIA_READ_URL_EXPIRES_IN_SECONDS: "60",
      SHARE_MEDIA_READ_URL_EXPIRES_IN_SECONDS: "90",
    });
    expect(config.mediaReadUrlExpiresInSeconds).toBe(60);
    expect(config.shareMediaReadUrlExpiresInSeconds).toBe(90);
  });

  // #200 phase F: the guest prefix carries its own budgets. #217 removed the
  // blanket `/api/*` bucket and these knobs deliberately do not restore it —
  // they configure `/api/shared/*` alone.
  it("defaults the guest share budgets", () => {
    const config = loadServerConfig(productionEnvironment);
    expect(config.shareRateLimitWindowSeconds).toBe(60);
    expect(config.shareDataRateLimit).toBe(60);
    expect(config.shareMediaRateLimit).toBe(240);
    expect(config.shareUnknownTokenRateLimit).toBe(30);
  });

  it("accepts explicit guest share budgets", () => {
    const config = loadServerConfig({
      ...productionEnvironment,
      SHARE_RATE_LIMIT_WINDOW_SECONDS: "30",
      SHARE_DATA_RATE_LIMIT: "120",
      SHARE_MEDIA_RATE_LIMIT: "600",
      SHARE_UNKNOWN_TOKEN_RATE_LIMIT: "10",
    });
    expect(config.shareRateLimitWindowSeconds).toBe(30);
    expect(config.shareDataRateLimit).toBe(120);
    expect(config.shareMediaRateLimit).toBe(600);
    expect(config.shareUnknownTokenRateLimit).toBe(10);
  });

  // The floors are product floors: #200 asks that a limit never break a normal
  // image-heavy Journey during playback prefetch, so a deployment cannot set a
  // budget below what one recipient legitimately needs.
  it("rejects a guest budget below its product floor or above its ceiling", () => {
    for (
      const [name, value, message] of [
        ["SHARE_RATE_LIMIT_WINDOW_SECONDS", "5", "between 10 and 3600"],
        ["SHARE_RATE_LIMIT_WINDOW_SECONDS", "7200", "between 10 and 3600"],
        ["SHARE_DATA_RATE_LIMIT", "1", "between 10 and 100000"],
        ["SHARE_MEDIA_RATE_LIMIT", "8", "between 30 and 100000"],
        ["SHARE_UNKNOWN_TOKEN_RATE_LIMIT", "0", "between 5 and 100000"],
        ["SHARE_DATA_RATE_LIMIT", "60.5", "between 10 and 100000"],
      ] as const
    ) {
      expect(() => loadServerConfig({ ...productionEnvironment, [name]: value }))
        .toThrow(`${name} must be ${message}`);
    }
  });
});
