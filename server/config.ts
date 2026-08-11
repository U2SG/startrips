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
    storageDriver: environment.STORAGE_DRIVER?.trim() || "disabled",
    locationSearchDriver:
      environment.LOCATION_SEARCH_DRIVER?.trim() || "disabled",
  } as const;
}

export type ServerConfig = ReturnType<typeof loadServerConfig>;

export const serverConfig = loadServerConfig();
