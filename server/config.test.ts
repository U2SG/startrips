import { createPrivateKey, generateKeyPairSync } from "node:crypto";
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

// #368: the cover-reveal worker is off unless a deployment names a credential.
describe("cover-reveal worker configuration", () => {
  it("leaves the worker unconfigured, and production unaffected, by default", () => {
    const config = loadServerConfig(productionEnvironment);
    expect(config.coverRevealWorkerToken).toBeNull();
    expect(config.coverRevealLeaseSeconds).toBe(600);
    expect(config.coverRevealSourceReadExpiresInSeconds).toBe(300);
    expect(config.coverRevealUploadExpiresInSeconds).toBe(600);
    expect(config.coverRevealMaxBytes).toBe(4 * 1024 * 1024);
    expect(config.coverRevealMaxEdgePixels).toBe(2048);
    expect(config.coverRevealMaxAttempts).toBe(3);
  });

  it("refuses an under-strength worker credential at startup", () => {
    expect(() => loadServerConfig({
      ...productionEnvironment,
      COVER_REVEAL_WORKER_TOKEN: "x".repeat(31),
    })).toThrow("COVER_REVEAL_WORKER_TOKEN must contain at least 32 characters");
    expect(loadServerConfig({
      ...productionEnvironment,
      COVER_REVEAL_WORKER_TOKEN: "x".repeat(32),
    }).coverRevealWorkerToken).toBe("x".repeat(32));
  });

  it("keeps every worker budget inside its band", () => {
    for (
      const [name, value, message] of [
        ["COVER_REVEAL_LEASE_SECONDS", "30", "between 60 and 3600"],
        ["COVER_REVEAL_LEASE_SECONDS", "7200", "between 60 and 3600"],
        [
          "COVER_REVEAL_SOURCE_READ_EXPIRES_IN_SECONDS",
          "10",
          "between 30 and 900",
        ],
        ["COVER_REVEAL_UPLOAD_EXPIRES_IN_SECONDS", "30", "between 60 and 3600"],
        ["COVER_REVEAL_MAX_BYTES", "1024", "between 65536 and 16777216"],
        ["COVER_REVEAL_MAX_EDGE_PIXELS", "8192", "between 256 and 4096"],
        ["COVER_REVEAL_MAX_ATTEMPTS", "0", "between 1 and 10"],
        ["COVER_REVEAL_MAX_ATTEMPTS", "2.5", "between 1 and 10"],
      ] as const
    ) {
      expect(() => loadServerConfig({ ...productionEnvironment, [name]: value }))
        .toThrow(`${name} must be ${message}`);
    }
  });

  // A capability that outlives the claim it belongs to would let a worker keep
  // reading a source, or keep writing an output, after another worker owns the
  // job.
  it("refuses a capability window longer than the lease it sits inside", () => {
    expect(() => loadServerConfig({
      ...productionEnvironment,
      COVER_REVEAL_LEASE_SECONDS: "60",
      COVER_REVEAL_UPLOAD_EXPIRES_IN_SECONDS: "600",
    })).toThrow("must not exceed COVER_REVEAL_LEASE_SECONDS");
    expect(() => loadServerConfig({
      ...productionEnvironment,
      COVER_REVEAL_LEASE_SECONDS: "120",
      COVER_REVEAL_SOURCE_READ_EXPIRES_IN_SECONDS: "300",
      COVER_REVEAL_UPLOAD_EXPIRES_IN_SECONDS: "120",
    })).toThrow("must not exceed COVER_REVEAL_LEASE_SECONDS");
  });
});

describe("Google sign-in configuration", () => {
  it("leaves the provider absent when no client is configured", () => {
    const config = loadServerConfig(productionEnvironment);
    expect(config.googleClientId).toBeNull();
    expect(config.googleClientSecret).toBeNull();
  });

  it("refuses a half-configured client at startup", () => {
    expect(() => loadServerConfig({
      ...productionEnvironment,
      GOOGLE_CLIENT_ID: "client.apps.googleusercontent.test",
    })).toThrow("GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set together");
    expect(() => loadServerConfig({
      ...productionEnvironment,
      GOOGLE_CLIENT_SECRET: "secret",
    })).toThrow("GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set together");
  });

  it("accepts both halves together", () => {
    const config = loadServerConfig({
      ...productionEnvironment,
      GOOGLE_CLIENT_ID: "client.apps.googleusercontent.test",
      GOOGLE_CLIENT_SECRET: "secret",
    });
    expect(config.googleClientId).toBe("client.apps.googleusercontent.test");
    expect(config.googleClientSecret).toBe("secret");
  });
});

// #350: the analogous config-driven cover for Sign in with Apple. Apple's
// credential is four values rather than two, and the private key is PEM text,
// so a half-named credential and a malformed key are both deployment mistakes
// worth refusing at startup rather than degrading into a provider that cannot
// complete an authorization.
describe("Apple sign-in configuration", () => {
  const privateKey = generateKeyPairSync("ec", { namedCurve: "P-256" })
    .privateKey.export({ type: "pkcs8", format: "pem" })
    .toString();
  const appleEnvironment = {
    APPLE_SERVICE_ID: "com.example.startrips.web",
    APPLE_TEAM_ID: "TEAM123456",
    APPLE_KEY_ID: "KEY7890123",
    APPLE_PRIVATE_KEY: privateKey,
  };

  it("leaves the provider absent when no credential is configured", () => {
    const config = loadServerConfig(productionEnvironment);
    expect(config.appleServiceId).toBeNull();
    expect(config.appleTeamId).toBeNull();
    expect(config.appleKeyId).toBeNull();
    expect(config.applePrivateKey).toBeNull();
    expect(config.appleAppBundleIdentifier).toBeNull();
  });

  it("refuses a half-named credential at startup", () => {
    expect(() => loadServerConfig({
      ...productionEnvironment,
      APPLE_SERVICE_ID: appleEnvironment.APPLE_SERVICE_ID,
    })).toThrow("APPLE_TEAM_ID, APPLE_KEY_ID, APPLE_PRIVATE_KEY required");
  });

  it("refuses a private key that is not PKCS#8 PEM text", () => {
    expect(() => loadServerConfig({
      ...productionEnvironment,
      ...appleEnvironment,
      APPLE_PRIVATE_KEY: "not-a-pem",
    })).toThrow("APPLE_PRIVATE_KEY must be the PKCS#8 PEM text");
  });

  it("accepts the whole credential together", () => {
    const config = loadServerConfig({ ...productionEnvironment, ...appleEnvironment });
    expect(config.appleServiceId).toBe(appleEnvironment.APPLE_SERVICE_ID);
    expect(config.appleTeamId).toBe(appleEnvironment.APPLE_TEAM_ID);
    expect(config.appleKeyId).toBe(appleEnvironment.APPLE_KEY_ID);
    expect(config.applePrivateKey).toContain("-----BEGIN PRIVATE KEY-----");
  });

  it("accepts a .p8 whose newlines arrived escaped through one variable", () => {
    const config = loadServerConfig({
      ...productionEnvironment,
      ...appleEnvironment,
      APPLE_PRIVATE_KEY: privateKey.split("\n").join("\\n"),
    });
    // The escaped form round-trips back to real PEM: the recovered text is
    // the key it started as, and Node can still parse it as PKCS#8.
    expect(config.applePrivateKey?.trim()).toBe(privateKey.trim());
    expect(() => createPrivateKey(config.applePrivateKey as string))
      .not.toThrow();
  });
});

describe("location search fallback configuration", () => {
  it("names no fallback unless a deployment configures one", () => {
    expect(loadServerConfig(productionEnvironment).locationSearchFallbackBaseUrl).toBeNull();
    expect(loadServerConfig({
      ...productionEnvironment,
      LOCATION_SEARCH_FALLBACK_BASE_URL: "https://nominatim.startrips.example/",
    }).locationSearchFallbackBaseUrl).toBe("https://nominatim.startrips.example");
  });

  it("requires HTTPS for the fallback in production", () => {
    expect(() => loadServerConfig({
      ...productionEnvironment,
      LOCATION_SEARCH_DRIVER: "photon",
      LOCATION_SEARCH_BASE_URL: "https://photon.startrips.example",
      LOCATION_SEARCH_FALLBACK_BASE_URL: "http://nominatim.startrips.example",
    })).toThrow("LOCATION_SEARCH_FALLBACK_BASE_URL must use HTTPS in production");
  });
});
