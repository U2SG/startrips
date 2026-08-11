import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { serverConfig } from "../config";
import * as schema from "./schema";

export const pool = new Pool({
  connectionString: serverConfig.databaseUrl,
  max: 10,
  ssl: serverConfig.databaseSsl
    ? {
        rejectUnauthorized: serverConfig.databaseSslRejectUnauthorized,
        ...(serverConfig.databaseSslCaBase64
          ? {
              ca: Buffer.from(
                serverConfig.databaseSslCaBase64,
                "base64",
              ).toString("utf8"),
            }
          : {}),
      }
    : undefined,
});

export const db = drizzle(pool, { schema });
