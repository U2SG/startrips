import { generateKeyPairSync } from "node:crypto";

/**
 * #350: the Apple credential the app under test is configured with.
 *
 * `server/config.ts` reads the environment once, when it is first imported, so
 * this module exists to run BEFORE `../app` does. A test file imports it first
 * and gets a real, complete credential — a freshly generated P-256 key that
 * never leaves the process — rather than a mocked provider. Everything Better
 * Auth then does with it (minting the client secret, verifying an id token
 * against the configured audience) is the production path.
 */

const keyPair = generateKeyPairSync("ec", { namedCurve: "P-256" });

export const APPLE_SERVICE_ID = "com.example.startrips.web";
export const APPLE_TEAM_ID = "ST133TEAM1";
export const APPLE_KEY_ID = "ST133KEYID";
export const APPLE_PRIVATE_KEY_PEM = keyPair.privateKey
  .export({ type: "pkcs8", format: "pem" })
  .toString();
export const applePrivateKey = keyPair.privateKey;
export const applePublicKey = keyPair.publicKey;

process.env.APPLE_SERVICE_ID = APPLE_SERVICE_ID;
process.env.APPLE_TEAM_ID = APPLE_TEAM_ID;
process.env.APPLE_KEY_ID = APPLE_KEY_ID;
process.env.APPLE_PRIVATE_KEY = APPLE_PRIVATE_KEY_PEM;
