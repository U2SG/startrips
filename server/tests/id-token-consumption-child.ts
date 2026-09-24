import { readFileSync } from "node:fs";
import { consumeVerifiedIdToken } from "../account-identities/id-token-consumption";
import { pool } from "../db/client";

/**
 * #350: the second process the replay store has to be shared with.
 *
 * `account-identity-apple.integration.test.ts` runs this file through a fresh
 * `node --import tsx`, so it has its own module registry, its own connection
 * pool and no memory of any request the test process made. It calls the
 * production `consumeVerifiedIdToken` — nothing here is a stand-in — and
 * reports only the verdict, which is what turns "the record is a row" from a
 * claim about the implementation into an observation across a real process
 * boundary.
 *
 * The token arrives on stdin rather than argv: argv is readable from the
 * process list, and the token is a live credential. It is never printed back.
 */
const input = JSON.parse(readFileSync(0, "utf8")) as {
  providerId: string;
  token: string;
};

const consumed = await consumeVerifiedIdToken({
  providerId: input.providerId,
  token: input.token,
});
process.stdout.write(`${JSON.stringify({ consumed })}\n`);
// The module-level pool would otherwise hold the event loop open and the
// parent would read a hang as a flake.
await pool.end();
