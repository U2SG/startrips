import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { loadServerConfig, type ServerConfig } from "../config";
import { APPLE_PROVIDER_ID, appleSignInOptions } from "./apple-provider";
import {
  bindableSocialProviderIds,
  configuredSocialProviderIds,
  createBindProvider,
  GOOGLE_PROVIDER_ID,
} from "./social-providers";

const privateKeyPem = generateKeyPairSync("ec", { namedCurve: "P-256" })
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString();

const APPLE_ENVIRONMENT = {
  APPLE_SERVICE_ID: "com.example.startrips.web",
  APPLE_TEAM_ID: "TEAM123456",
  APPLE_KEY_ID: "KEY7890123",
  APPLE_PRIVATE_KEY: privateKeyPem,
};

function config(overrides: Record<string, string> = {}): ServerConfig {
  return loadServerConfig({
    APP_ORIGIN: "http://127.0.0.1:5173",
    ...overrides,
  });
}

describe("Apple provider configuration", () => {
  it("has no provider and advertises no id while the credential is absent", () => {
    expect(appleSignInOptions(config())).toBeNull();
    expect([...configuredSocialProviderIds(config())]).toEqual([]);
  });

  it("refuses a half-named credential at startup instead of degrading to a mock", () => {
    expect(() => config({ APPLE_SERVICE_ID: APPLE_ENVIRONMENT.APPLE_SERVICE_ID }))
      .toThrow("APPLE_TEAM_ID, APPLE_KEY_ID, APPLE_PRIVATE_KEY required");
    expect(() => config({ ...APPLE_ENVIRONMENT, APPLE_PRIVATE_KEY: "not-a-pem" }))
      .toThrow("APPLE_PRIVATE_KEY must be the PKCS#8 PEM text");
  });

  it("builds the pinned adapter's options from the credential alone", () => {
    const options = appleSignInOptions(config(APPLE_ENVIRONMENT));
    expect(options?.clientId).toBe(APPLE_ENVIRONMENT.APPLE_SERVICE_ID);
    expect(options?.audience).toEqual([APPLE_ENVIRONMENT.APPLE_SERVICE_ID]);
    // Minted on read, so the process never holds an expiring value.
    expect(options?.clientSecret).toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/);
  });

  it("accepts a native bundle identifier as an audience only when one is named", () => {
    const options = appleSignInOptions(config({
      ...APPLE_ENVIRONMENT,
      APPLE_APP_BUNDLE_IDENTIFIER: "com.example.startrips",
    }));
    expect(options?.audience).toEqual([
      APPLE_ENVIRONMENT.APPLE_SERVICE_ID,
      "com.example.startrips",
    ]);
  });

  it("advertises the apple id exactly when the full credential is present", () => {
    expect([...configuredSocialProviderIds(config(APPLE_ENVIRONMENT))])
      .toEqual([APPLE_PROVIDER_ID]);
  });

  // #504: the bind round trip receives Apple's `form_post` return, so the
  // full credential makes apple bindable as well as usable.
  it("advertises apple as bindable exactly when the full credential is present", () => {
    expect([...bindableSocialProviderIds(config(APPLE_ENVIRONMENT))])
      .toEqual([APPLE_PROVIDER_ID]);
    expect([...bindableSocialProviderIds(config({}))]).toEqual([]);
  });

  // #504: the per-provider PKCE opt-out. Apple's adapter sends no challenge,
  // so the bind route must mint and forward no verifier for it.
  it("opts the apple bind adapter out of PKCE", () => {
    const provider = createBindProvider(APPLE_PROVIDER_ID, config(APPLE_ENVIRONMENT));
    expect(provider?.pkce).toBe(false);
    expect(createBindProvider(APPLE_PROVIDER_ID, config({}))).toBeNull();
    const google = createBindProvider(GOOGLE_PROVIDER_ID, config({
      GOOGLE_CLIENT_ID: "st140-client.apps.googleusercontent.test",
      GOOGLE_CLIENT_SECRET: "st140-client-secret",
    }));
    expect(google?.pkce).toBe(true);
  });

  // The secret is minted per exchange, not frozen at startup: the pinned
  // adapter reads `options.clientSecret` when it builds the token request, and
  // a value captured once would expire while the process kept running.
  it("mints a fresh client secret on every read rather than freezing one", () => {
    const options = appleSignInOptions(config(APPLE_ENVIRONMENT));
    const first = options?.clientSecret;
    expect(first).toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/);
    expect(Object.getOwnPropertyDescriptor(options, "clientSecret")?.get)
      .toBeTypeOf("function");
  });
});
