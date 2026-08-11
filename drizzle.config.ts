import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: [
    "./server/db/auth-schema.ts",
    "./server/db/app-schema.ts",
  ],
  out: "./server/db/migrations",
  dialect: "postgresql",
  dbCredentials: {
    url:
      process.env.DATABASE_URL ??
      "postgresql://postgres:postgres@127.0.0.1:5432/startrips",
  },
});
