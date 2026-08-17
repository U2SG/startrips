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
  const anonymousRateLimitWindowSeconds = Number(
    environment.ANON_RATE_LIMIT_WINDOW_SECONDS ?? 60,
  );
  const anonymousRateLimitMaxRequests = Number(
    environment.ANON_RATE_LIMIT_MAX_REQUESTS ?? 60,
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

  if (
    !Number.isInteger(anonymousRateLimitWindowSeconds)
    || anonymousRateLimitWindowSeconds < 1
    || anonymousRateLimitWindowSeconds > 3600
  ) {
    throw new Error(
      "ANON_RATE_LIMIT_WINDOW_SECONDS must be an integer between 1 and 3600",
    );
  }
  if (
    !Number.isInteger(anonymousRateLimitMaxRequests)
    || anonymousRateLimitMaxRequests < 1
    || anonymousRateLimitMaxRequests > 100000
  ) {
    throw new Error(
      "ANON_RATE_LIMIT_MAX_REQUESTS must be an integer between 1 and 100000",
    );
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
    locationSearchDriver,
    locationSearchBaseUrl,
    locationSearchUserAgent,
    anonymousRateLimitWindowSeconds,
    anonymousRateLimitMaxRequests,
  } as const;
}

export type ServerConfig = ReturnType<typeof loadServerConfig>;

export const serverConfig = loadServerConfig();
