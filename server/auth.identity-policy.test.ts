import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  STARTRIPS_ACCOUNT_LINKING_POLICY,
  STARTRIPS_DISABLED_IDENTITY_PATHS,
} from "./auth";

describe("Better Auth account identity safety configuration", () => {
  it("stays pinned to Better Auth 1.6.23", () => {
    const pkg = JSON.parse(readFileSync(resolve(process.cwd(), "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
    };
    expect(pkg.dependencies["better-auth"]).toBe("1.6.23");
    expect(pkg.dependencies["@better-auth/drizzle-adapter"]).toBe("1.6.23");
  });

  it("turns off implicit/native account management so email equality cannot link identities", () => {
    expect(STARTRIPS_ACCOUNT_LINKING_POLICY).toEqual({
      enabled: false,
      disableImplicitLinking: true,
      allowDifferentEmails: false,
      allowUnlinkingAll: false,
      updateUserInfoOnLink: false,
    });
    expect(STARTRIPS_DISABLED_IDENTITY_PATHS).toEqual([
      "/link-social",
      "/unlink-account",
      "/list-accounts",
      "/change-email",
    ]);
  });
});
