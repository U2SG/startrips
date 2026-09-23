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
  // #349: the one social sign-in provider Startrips configures. Both halves
  // are deployment secrets with no development fallback, because a shared
  // default OAuth client is the same as no client at all. Absent means this
  // deployment does not offer Google at all: `server/auth.ts` omits the
  // provider entirely rather than mounting a mocked one, and
  // `/api/account-identities` never advertises it.
  const googleClientId = environment.GOOGLE_CLIENT_ID?.trim() || null;
  const googleClientSecret = environment.GOOGLE_CLIENT_SECRET?.trim() || null;
  // #368: the cover-reveal worker, which is off unless a deployment names a
  // credential. There is no development fallback and no production
  // requirement: an absent value means this deployment runs no worker, so the
  // worker routes refuse everything and the rest of the API is unaffected. A
  // fallback would be worse than either, because a shared default credential
  // is the same as no credential at all.
  const coverRevealWorkerToken =
    environment.COVER_REVEAL_WORKER_TOKEN?.trim() || null;
  // How long one claim owns a job. Long enough for a local generation pass,
  // short enough that a worker that died mid-job does not park the Journey's
  // derivative until someone notices. An expired lease is reclaimable, so this
  // is the cost of a crash rather than a deadline the worker must meet.
  const coverRevealLeaseSeconds = Number(
    environment.COVER_REVEAL_LEASE_SECONDS ?? 10 * 60,
  );
  // The source read and the output write are each presigned for their own
  // short window, both inside the lease. They are separate knobs because they
  // buy different things: a read has to survive a slow download of one
  // original, a write has to survive a slow upload of a generated still.
  const coverRevealSourceReadExpiresInSeconds = Number(
    environment.COVER_REVEAL_SOURCE_READ_EXPIRES_IN_SECONDS ?? 5 * 60,
  );
  const coverRevealUploadExpiresInSeconds = Number(
    environment.COVER_REVEAL_UPLOAD_EXPIRES_IN_SECONDS ?? 10 * 60,
  );
  // The two ceilings a completion is measured against, enforced against the
  // object that actually landed exactly as #260's are. A derivative is a
  // full-bleed opening frame rather than a thumbnail, so both are larger than
  // the preview budget and both still bound what one job can cost.
  const coverRevealMaxBytes = Number(
    environment.COVER_REVEAL_MAX_BYTES ?? 4 * 1024 * 1024,
  );
  const coverRevealMaxEdgePixels = Number(
    environment.COVER_REVEAL_MAX_EDGE_PIXELS ?? 2048,
  );
  // Bounded retries: a job that has failed this many times stops being
  // claimable instead of cycling a broken source through every worker pass.
  const coverRevealMaxAttempts = Number(
    environment.COVER_REVEAL_MAX_ATTEMPTS ?? 3,
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
  // #350: Sign in with Apple. Apple issues no static client secret — the
  // "secret" is an ES256 JWT this server signs from a Team id, a Key id and a
  // downloaded .p8 private key, so all four values are one credential and none
  // of them ever reaches the browser. They are optional the same way the
  // storage credential is: a deployment that names none runs no Apple provider
  // at all rather than a mocked one. Naming some but not all is a deployment
  // mistake worth failing at startup for, in every environment, because a
  // half-configured provider would advertise a sign-in that cannot complete.
  const appleServiceId = environment.APPLE_SERVICE_ID?.trim() || null;
  const appleTeamId = environment.APPLE_TEAM_ID?.trim() || null;
  const appleKeyId = environment.APPLE_KEY_ID?.trim() || null;
  // A .p8 file is PEM text. Passing it through a single environment variable
  // means its newlines usually arrive as the two characters `\n`, so accept
  // both forms rather than making every deployment pick the right one.
  const applePrivateKey = environment.APPLE_PRIVATE_KEY?.trim()
    .replace(/\\n/g, "\n") || null;
  // The native app's bundle identifier, accepted as an additional id-token
  // audience. #350 ships the web flow only, so this stays optional.
  const appleAppBundleIdentifier =
    environment.APPLE_APP_BUNDLE_IDENTIFIER?.trim() || null;
  const appleConfigurationPresent = Boolean(
    appleServiceId || appleTeamId || appleKeyId || applePrivateKey,
  );
  if (appleConfigurationPresent) {
    const missing = [
      ["APPLE_SERVICE_ID", appleServiceId],
      ["APPLE_TEAM_ID", appleTeamId],
      ["APPLE_KEY_ID", appleKeyId],
      ["APPLE_PRIVATE_KEY", applePrivateKey],
    ].filter(([, value]) => !value).map(([name]) => name);
    if (missing.length > 0) {
      throw new Error(
        `${missing.join(", ")} required when Sign in with Apple is configured`,
      );
    }
    if (!/^-----BEGIN PRIVATE KEY-----/.test(applePrivateKey as string)) {
      throw new Error(
        "APPLE_PRIVATE_KEY must be the PKCS#8 PEM text of the downloaded .p8 key",
      );
    }
  }

  // #512: the itinerary import providers. Both default to `disabled` and both
  // say so truthfully when asked to work, exactly as storage and place search
  // do: pasted-text import keeps working with neither of them configured, and
  // neither ever invents a reading or a page.
  const itineraryRecognitionDriver =
    environment.ITINERARY_RECOGNITION_DRIVER?.trim() || "disabled";
  const itineraryRecognitionBaseUrl =
    environment.ITINERARY_RECOGNITION_BASE_URL?.trim() || null;
  // Never sent to a browser. The recogniser is called from the server only.
  const itineraryRecognitionApiKey =
    environment.ITINERARY_RECOGNITION_API_KEY?.trim() || null;
  // Configuration, not a domain contract: a newer build is a deployment
  // change, and the value is recorded on every reading it produces.
  const itineraryRecognitionModel =
    environment.ITINERARY_RECOGNITION_MODEL?.trim() || "unversioned";
  const itineraryRecognitionTimeoutMs = Number(
    environment.ITINERARY_RECOGNITION_TIMEOUT_MS ?? 60_000,
  );
  const itinerarySourceFetchDriver =
    environment.ITINERARY_SOURCE_FETCH_DRIVER?.trim() || "disabled";
  const itinerarySourceRenderUrl =
    environment.ITINERARY_SOURCE_RENDER_URL?.trim() || null;
  const itinerarySourceFetchTimeoutMs = Number(
    environment.ITINERARY_SOURCE_FETCH_TIMEOUT_MS ?? 20_000,
  );
  const itinerarySourceMaxBytes = Number(
    environment.ITINERARY_SOURCE_MAX_BYTES ?? 4 * 1024 * 1024,
  );

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
  // Exactly one half is a deployment mistake, not a disabled provider: the
  // operator meant to enable Google and would otherwise get a sign-in entry
  // that cannot complete. Fail at startup like an incomplete S3 configuration.
  if (Boolean(googleClientId) !== Boolean(googleClientSecret)) {
    throw new Error(
      "GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set together",
    );
  }
  // #368: an under-strength worker credential is refused at startup rather
  // than accepted and hashed. The credential is a bearer secret with no
  // second factor and no rate limit of its own, so its entropy is the whole
  // defence, and a deployment that sets a short one has made a mistake it
  // should hear about before the process serves a request.
  if (
    coverRevealWorkerToken
    && coverRevealWorkerToken.length < 32
  ) {
    throw new Error(
      "COVER_REVEAL_WORKER_TOKEN must contain at least 32 characters",
    );
  }
  for (
    const [name, value, floor, ceiling] of [
      ["COVER_REVEAL_LEASE_SECONDS", coverRevealLeaseSeconds, 60, 60 * 60],
      [
        "COVER_REVEAL_SOURCE_READ_EXPIRES_IN_SECONDS",
        coverRevealSourceReadExpiresInSeconds,
        30,
        15 * 60,
      ],
      [
        "COVER_REVEAL_UPLOAD_EXPIRES_IN_SECONDS",
        coverRevealUploadExpiresInSeconds,
        60,
        60 * 60,
      ],
      ["COVER_REVEAL_MAX_BYTES", coverRevealMaxBytes, 64 * 1024, 16 * 1024 * 1024],
      ["COVER_REVEAL_MAX_EDGE_PIXELS", coverRevealMaxEdgePixels, 256, 4096],
      ["COVER_REVEAL_MAX_ATTEMPTS", coverRevealMaxAttempts, 1, 10],
    ] as const
  ) {
    if (!Number.isInteger(value) || value < floor || value > ceiling) {
      throw new Error(`${name} must be between ${floor} and ${ceiling}`);
    }
  }
  // A capability that outlives the claim it belongs to would let a worker keep
  // reading a source, or keep writing an output, after another worker owns the
  // job. Both windows therefore have to close no later than the lease.
  if (
    coverRevealSourceReadExpiresInSeconds > coverRevealLeaseSeconds
    || coverRevealUploadExpiresInSeconds > coverRevealLeaseSeconds
  ) {
    throw new Error(
      "COVER_REVEAL_SOURCE_READ_EXPIRES_IN_SECONDS and "
      + "COVER_REVEAL_UPLOAD_EXPIRES_IN_SECONDS must not exceed "
      + "COVER_REVEAL_LEASE_SECONDS",
    );
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
  if (
    itineraryRecognitionDriver !== "disabled"
    && itineraryRecognitionDriver !== "http-model"
  ) {
    throw new Error(
      `ITINERARY_RECOGNITION_DRIVER "${itineraryRecognitionDriver}" is not installed`,
    );
  }
  if (itineraryRecognitionDriver === "http-model" && !itineraryRecognitionBaseUrl) {
    throw new Error(
      "ITINERARY_RECOGNITION_BASE_URL required when ITINERARY_RECOGNITION_DRIVER=http-model",
    );
  }
  if (
    itinerarySourceFetchDriver !== "disabled"
    && itinerarySourceFetchDriver !== "http"
    && itinerarySourceFetchDriver !== "render"
  ) {
    throw new Error(
      `ITINERARY_SOURCE_FETCH_DRIVER "${itinerarySourceFetchDriver}" is not installed`,
    );
  }
  if (itinerarySourceFetchDriver === "render" && !itinerarySourceRenderUrl) {
    throw new Error(
      "ITINERARY_SOURCE_RENDER_URL required when ITINERARY_SOURCE_FETCH_DRIVER=render",
    );
  }
  for (
    const [name, value] of [
      ["ITINERARY_RECOGNITION_TIMEOUT_MS", itineraryRecognitionTimeoutMs],
      ["ITINERARY_SOURCE_FETCH_TIMEOUT_MS", itinerarySourceFetchTimeoutMs],
    ] as const
  ) {
    if (!Number.isInteger(value) || value < 1_000 || value > 300_000) {
      throw new Error(`${name} must be between 1000 and 300000 milliseconds`);
    }
  }
  if (
    !Number.isInteger(itinerarySourceMaxBytes)
    || itinerarySourceMaxBytes < 64 * 1024
    || itinerarySourceMaxBytes > 32 * 1024 * 1024
  ) {
    throw new Error("ITINERARY_SOURCE_MAX_BYTES must be between 65536 and 33554432");
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
    googleClientId,
    googleClientSecret,
    coverRevealWorkerToken,
    coverRevealLeaseSeconds,
    coverRevealSourceReadExpiresInSeconds,
    coverRevealUploadExpiresInSeconds,
    coverRevealMaxBytes,
    coverRevealMaxEdgePixels,
    coverRevealMaxAttempts,
    shareRateLimitWindowSeconds,
    shareDataRateLimit,
    shareMediaRateLimit,
    shareUnknownTokenRateLimit,
    locationSearchDriver,
    locationSearchBaseUrl,
    locationSearchUserAgent,
    appleServiceId,
    appleTeamId,
    appleKeyId,
    applePrivateKey,
    appleAppBundleIdentifier,
    itineraryRecognitionDriver,
    itineraryRecognitionBaseUrl,
    itineraryRecognitionApiKey,
    itineraryRecognitionModel,
    itineraryRecognitionTimeoutMs,
    itinerarySourceFetchDriver,
    itinerarySourceRenderUrl,
    itinerarySourceFetchTimeoutMs,
    itinerarySourceMaxBytes,
  } as const;
}

export type ServerConfig = ReturnType<typeof loadServerConfig>;

export const serverConfig = loadServerConfig();
