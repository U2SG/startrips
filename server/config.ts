const DEVELOPMENT_SECRET =
  "development-only-startrips-secret-change-before-production";

function booleanValue(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return value === "true" || value === "1";
}

function requiredInProduction(
  name: string,
  value: string | undefined,
  fallback: string,
  production: boolean,
): string {
  if (value) return value;
  if (!production) return fallback;
  throw new Error(`${name} is required in production`);
}

export function loadServerConfig(
  environment: NodeJS.ProcessEnv = process.env,
) {
  const production = environment.NODE_ENV === "production";
  const appOrigin = requiredInProduction(
    "APP_ORIGIN",
    environment.APP_ORIGIN,
    "http://127.0.0.1:5173",
    production,
  ).replace(/\/$/, "");
  const parsedOrigin = new URL(appOrigin);
  const smtpUrl = environment.SMTP_URL?.trim() || null;
  const mailFrom = environment.MAIL_FROM?.trim() || null;
  const apiPort = Number(environment.API_PORT ?? 8787);
  const storageDriver = environment.STORAGE_DRIVER?.trim() || "disabled";
  const s3BackendId = environment.S3_BACKEND_ID?.trim() || null;
  const s3Endpoint = environment.S3_ENDPOINT?.trim().replace(/\/$/, "") || null;
  const s3KeyPrefix = environment.S3_KEY_PREFIX?.trim()
    .replace(/^\/+|\/+$/g, "") || null;
  const s3Region = environment.S3_REGION?.trim() || null;
  const s3Bucket = environment.S3_BUCKET?.trim() || null;
  const s3AccessKeyId = environment.S3_ACCESS_KEY_ID?.trim() || null;
  const s3SecretAccessKey = environment.S3_SECRET_ACCESS_KEY?.trim() || null;
  const s3SessionToken = environment.S3_SESSION_TOKEN?.trim() || null;
  const s3ForcePathStyle = booleanValue(environment.S3_FORCE_PATH_STYLE, false);
  const s3UploadPartExpiresInSeconds = Number(
    environment.S3_UPLOAD_PART_EXPIRES_IN_SECONDS ?? 15 * 60,
  );
  const mediaReadUrlExpiresInSeconds = Number(
    environment.MEDIA_READ_URL_EXPIRES_IN_SECONDS ?? 15 * 60,
  );
  // #200 phase C: a share guest gets its own, much shorter media read lifetime
  // than the owner's ~15 minutes, because an already-issued presigned URL is
  // the one thing a revoke cannot reach. 90 seconds sits inside the 60-120
  // second band #200 recommends. This is only the ceiling; the issued value is
  // additionally capped by the grant's remaining lifetime at presign time.
  const shareMediaReadUrlExpiresInSeconds = Number(
    environment.SHARE_MEDIA_READ_URL_EXPIRES_IN_SECONDS ?? 90,
  );
  // #260: the two ceilings every derived preview is planned against, and both
  // are enforced against the object that actually landed rather than against
  // the plan a producer was handed.
  //
  // Completion measures the produced object's byte size and reads it back to
  // establish its encoded pixel size; a preview that breaks either ceiling
  // never reaches "ready" and is never signed. So a consumer may treat both
  // numbers as properties of anything it is served, which is what makes the
  // longest-edge ceiling usable as a decode-cost bound.
  //
  // 640 px carries a full-bleed phone frame at 2x without approaching the
  // original, and 512 KiB is several times what a 640 px JPEG of a photograph
  // costs, so the byte ceiling bites only on pathological input.
  const mediaPreviewMaxEdgePixels = Number(
    environment.MEDIA_PREVIEW_MAX_EDGE_PIXELS ?? 640,
  );
  const mediaPreviewMaxBytes = Number(
    environment.MEDIA_PREVIEW_MAX_BYTES ?? 512 * 1024,
  );
  // The preview write is presigned to its own short lifetime rather than
  // borrowing the multipart part window. A single-object PUT has no upload
  // session, so there is nothing to abort mid-flight. A producer calls
  // `POST .../preview` with the still already rasterised and under
  // `MEDIA_PREVIEW_MAX_BYTES`, so two minutes is generous, and it bounds the
  // window in which a write issued just before a Journey is deleted could
  // still land after the row cascaded away. What that write leaves behind is
  // not bounded by this clock at all, and deliberately so: an expired
  // signature says a new request cannot START, never that one already running
  // has finished. `reconcilePreviewWrites()` retires the keys it recorded, and
  // `reconcilePreviewNamespace()` enumerates the preview prefix itself and
  // deletes every object no `media_assets` row references, so a late write is
  // discoverable however long it took to arrive.
  const mediaPreviewUploadExpiresInSeconds = Number(
    environment.MEDIA_PREVIEW_UPLOAD_EXPIRES_IN_SECONDS ?? 120,
  );
  // #200 phase F: the guest prefix is the only public, unauthenticated surface
  // Startrips exposes, so it carries its own budgets rather than the blanket
  // `/api/*` bucket #217 removed. One window, three ceilings; see
  // `server/share-rate-limit.ts` for what each subject is.
  const shareRateLimitWindowSeconds = Number(
    environment.SHARE_RATE_LIMIT_WINDOW_SECONDS ?? 60,
  );
  const shareDataRateLimit = Number(
    environment.SHARE_DATA_RATE_LIMIT ?? 60,
  );
  const shareMediaRateLimit = Number(
    environment.SHARE_MEDIA_RATE_LIMIT ?? 240,
  );
  const shareUnknownTokenRateLimit = Number(
    environment.SHARE_UNKNOWN_TOKEN_RATE_LIMIT ?? 30,
  );
  const s3ConfigurationPresent = Boolean(
    s3BackendId
    || s3Endpoint
    || s3KeyPrefix
    || s3Region
    || s3Bucket
    || s3AccessKeyId
    || s3SecretAccessKey
    || s3SessionToken,
  );
  const locationSearchDriver =
    environment.LOCATION_SEARCH_DRIVER?.trim() || "disabled";
  const locationSearchBaseUrl = (
    environment.LOCATION_SEARCH_BASE_URL?.trim()
    || "https://nominatim.openstreetmap.org"
  ).replace(/\/$/, "");
  const locationSearchUserAgent = environment.LOCATION_SEARCH_USER_AGENT?.trim()
    || `Startrips/1.0 (${appOrigin})`;

  if (production && (!smtpUrl || !mailFrom)) {
    throw new Error("SMTP_URL and MAIL_FROM are required in production");
  }
  if (
    parsedOrigin.pathname !== "/" ||
    parsedOrigin.search ||
    parsedOrigin.hash ||
    parsedOrigin.username ||
    parsedOrigin.password
  ) {
    throw new Error("APP_ORIGIN must contain only scheme, host, and optional port");
  }
  if (production && parsedOrigin.protocol !== "https:") {
    throw new Error("APP_ORIGIN must use HTTPS in production");
  }
  if (!Number.isInteger(apiPort) || apiPort < 1 || apiPort > 65535) {
    throw new Error("API_PORT must be an integer between 1 and 65535");
  }
  if (storageDriver !== "disabled" && storageDriver !== "s3") {
    throw new Error(`STORAGE_DRIVER "${storageDriver}" is not installed`);
  }
  if (
    !Number.isInteger(s3UploadPartExpiresInSeconds)
    || s3UploadPartExpiresInSeconds < 60
    || s3UploadPartExpiresInSeconds > 60 * 60
  ) {
    throw new Error(
      "S3_UPLOAD_PART_EXPIRES_IN_SECONDS must be between 60 and 3600",
    );
  }
  if (
    !Number.isInteger(mediaReadUrlExpiresInSeconds)
    || mediaReadUrlExpiresInSeconds < 60
    || mediaReadUrlExpiresInSeconds > 60 * 60
  ) {
    throw new Error(
      "MEDIA_READ_URL_EXPIRES_IN_SECONDS must be between 60 and 3600",
    );
  }
  // A lower floor than the owner value on purpose: 15 seconds is short but
  // still long enough to start a media fetch, and the point of this knob is to
  // allow a shorter guest lifetime than an owner is ever given. The ceiling is
  // ten minutes so a deployment cannot quietly turn a share link into a
  // long-lived object-storage credential.
  if (
    !Number.isInteger(shareMediaReadUrlExpiresInSeconds)
    || shareMediaReadUrlExpiresInSeconds < 15
    || shareMediaReadUrlExpiresInSeconds > 10 * 60
  ) {
    throw new Error(
      "SHARE_MEDIA_READ_URL_EXPIRES_IN_SECONDS must be between 15 and 600",
    );
  }
  if (
    !Number.isInteger(mediaPreviewMaxEdgePixels)
    || mediaPreviewMaxEdgePixels < 64
    || mediaPreviewMaxEdgePixels > 4096
  ) {
    throw new Error(
      "MEDIA_PREVIEW_MAX_EDGE_PIXELS must be between 64 and 4096",
    );
  }
  if (
    !Number.isInteger(mediaPreviewUploadExpiresInSeconds)
    || mediaPreviewUploadExpiresInSeconds < 30
    || mediaPreviewUploadExpiresInSeconds > 15 * 60
  ) {
    throw new Error(
      "MEDIA_PREVIEW_UPLOAD_EXPIRES_IN_SECONDS must be between 30 and 900",
    );
  }
  if (
    !Number.isInteger(mediaPreviewMaxBytes)
    || mediaPreviewMaxBytes < 16 * 1024
    || mediaPreviewMaxBytes > 8 * 1024 * 1024
  ) {
    throw new Error(
      "MEDIA_PREVIEW_MAX_BYTES must be between 16384 and 8388608",
    );
  }
  // The floors are product floors, not safety margins: #200 is explicit that a
  // limit which breaks a normal image-heavy Journey during playback prefetch
  // is a worse outcome than the abuse it prevents, so a deployment cannot set
  // a budget below what one recipient legitimately needs.
  //
  // At the defaults, per grant per minute:
  //
  // - data 60. One open viewer boots with one `/journeys` read and re-reads no
  //   faster than `SHARE_EXPIRY_RECHECK_MIN_MS` (15 s), i.e. 4/min per tab, so
  //   60 carries roughly fifteen simultaneous recipients of one link.
  // - media 240. A guest presign lives 90 s and `mediaReadRefreshAt` replaces
  //   it at half-life, so one continuously displayed asset costs about 1.3
  //   reads/min; 240 sustains roughly 180 such assets, or thirty full
  //   `MAX_PREFETCH_ASSETS` (8) prefetch bursts a minute. The budget belongs to
  //   the link, so a #197 fast-tempo burst is measured against the grant rather
  //   than against whichever recipient happens to share an address.
  //
  // The address budget is 30 unusable requests per minute. It does not make a
  // 256-bit token guessable-or-not — nothing does — it caps what a flood costs.
  for (
    const [name, value, floor, ceiling] of [
      ["SHARE_RATE_LIMIT_WINDOW_SECONDS", shareRateLimitWindowSeconds, 10, 3600],
      ["SHARE_DATA_RATE_LIMIT", shareDataRateLimit, 10, 100_000],
      ["SHARE_MEDIA_RATE_LIMIT", shareMediaRateLimit, 30, 100_000],
      ["SHARE_UNKNOWN_TOKEN_RATE_LIMIT", shareUnknownTokenRateLimit, 5, 100_000],
    ] as const
  ) {
    if (!Number.isInteger(value) || value < floor || value > ceiling) {
      throw new Error(`${name} must be between ${floor} and ${ceiling}`);
    }
  }
  if (storageDriver === "s3" || s3ConfigurationPresent) {
    const missing = [
      ["S3_BACKEND_ID", s3BackendId],
      ["S3_REGION", s3Region],
      ["S3_BUCKET", s3Bucket],
      ["S3_ACCESS_KEY_ID", s3AccessKeyId],
      ["S3_SECRET_ACCESS_KEY", s3SecretAccessKey],
    ].filter(([, value]) => !value).map(([name]) => name);
    if (missing.length > 0) {
      throw new Error(
        `${missing.join(", ")} required when STORAGE_DRIVER=s3`,
      );
    }
    if (
      s3BackendId === "disabled"
      || s3BackendId === "s3"
      || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(s3BackendId as string)
    ) {
      throw new Error(
        "S3_BACKEND_ID must be a stable lowercase identifier other than s3 or disabled",
      );
    }
  }
  if (s3Endpoint) {
    const parsedS3Endpoint = new URL(s3Endpoint);
    if (production && parsedS3Endpoint.protocol !== "https:") {
      throw new Error("S3_ENDPOINT must use HTTPS in production");
    }
  }
  if (
    s3KeyPrefix
    && s3KeyPrefix
      .split("/")
      .some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error("S3_KEY_PREFIX must contain normal non-empty path segments");
  }
  const parsedLocationSearchBaseUrl = new URL(locationSearchBaseUrl);
  if (
    locationSearchDriver !== "disabled"
    && production
    && parsedLocationSearchBaseUrl.protocol !== "https:"
  ) {
    throw new Error("LOCATION_SEARCH_BASE_URL must use HTTPS in production");
  }

  const authSecret = requiredInProduction(
    "BETTER_AUTH_SECRET",
    environment.BETTER_AUTH_SECRET,
    DEVELOPMENT_SECRET,
    production,
  );
  if (production && authSecret.length < 32) {
    throw new Error("BETTER_AUTH_SECRET must contain at least 32 characters");
  }

  return {
    production,
    appOrigin,
    apiHost:
      environment.API_HOST?.trim() || (production ? "0.0.0.0" : "127.0.0.1"),
    apiPort,
    databaseUrl: requiredInProduction(
      "DATABASE_URL",
      environment.DATABASE_URL,
      "postgresql://postgres:postgres@127.0.0.1:5432/startrips",
      production,
    ),
    databaseSsl: booleanValue(environment.DATABASE_SSL, production),
    databaseSslRejectUnauthorized: booleanValue(
      environment.DATABASE_SSL_REJECT_UNAUTHORIZED,
      true,
    ),
    databaseSslCaBase64:
      environment.DATABASE_SSL_CA_BASE64?.trim() || null,
    authSecret,
    smtpUrl,
    mailFrom,
    storageDriver,
    s3BackendId,
    s3Endpoint,
    s3KeyPrefix,
    s3Region,
    s3Bucket,
    s3AccessKeyId,
    s3SecretAccessKey,
    s3SessionToken,
    s3ForcePathStyle,
    s3UploadPartExpiresInSeconds,
    mediaReadUrlExpiresInSeconds,
    shareMediaReadUrlExpiresInSeconds,
    mediaPreviewMaxEdgePixels,
    mediaPreviewMaxBytes,
    mediaPreviewUploadExpiresInSeconds,
    shareRateLimitWindowSeconds,
    shareDataRateLimit,
    shareMediaRateLimit,
    shareUnknownTokenRateLimit,
    locationSearchDriver,
    locationSearchBaseUrl,
    locationSearchUserAgent,
  } as const;
}

export type ServerConfig = ReturnType<typeof loadServerConfig>;

export const serverConfig = loadServerConfig();
