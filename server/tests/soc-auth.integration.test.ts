import { randomUUID } from "node:crypto";
import { createEmailVerificationToken } from "better-auth/api";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { app } from "../app";
import { serverConfig } from "../config";
import { db } from "../db/client";
import { rateLimit, user } from "../db/auth-schema";

const origin = "http://127.0.0.1:5173";
const email = `soc-native-${randomUUID()}@example.test`;
const password = "test-only-soc-password";
const headers = { origin, "Content-Type": "application/json" };
afterAll(async () => { await db.delete(user).where(eq(user.email, email)); });

describe("shared Startrips native and browser sessions", () => {
  it("signs native tokens, shares the browser identity, and revokes native access on logout", async () => {
    await db.delete(rateLimit);
    const signup = await app.request(`${origin}/api/auth/sign-up/email`, {
      method: "POST", headers, body: JSON.stringify({ name: "Soc", email, password }),
    });
    expect(signup.status).toBe(200);
    const verificationToken = await createEmailVerificationToken(serverConfig.authSecret, email);
    const verification = await app.request(`${origin}/api/auth/verify-email?token=${encodeURIComponent(verificationToken)}`, { headers });
    expect(verification.status).toBe(200);
    const signin = await app.request(`${origin}/api/auth/sign-in/email`, {
      method: "POST", headers, body: JSON.stringify({ email, password }),
    });
    expect(signin.status).toBe(200);
    const token = signin.headers.get("set-auth-token");
    expect(token).toBeTruthy();
    const cookie = signin.headers.get("set-cookie")?.match(/(?:__Secure-)?startrips\.session_token=[^;,\s]+/)?.[0];
    expect(cookie).toBeTruthy();
    const native = await app.request(`${origin}/api/soc/session`, { headers: { Authorization: `Bearer ${token}` } });
    const browser = await app.request(`${origin}/api/soc/session`, { headers: { cookie: cookie! } });
    expect(native.status).toBe(200);
    expect(await native.json()).toEqual(await browser.json());
    const unsigned = decodeURIComponent(token!).split(".")[0];
    expect((await app.request(`${origin}/api/soc/session`, { headers: { Authorization: `Bearer ${unsigned}` } })).status).toBe(401);
    const signout = await app.request(`${origin}/api/auth/sign-out`, { method: "POST", headers: { ...headers, Authorization: `Bearer ${token}` }, body: "{}" });
    expect(signout.status).toBe(200);
    expect((await app.request(`${origin}/api/soc/session`, { headers: { Authorization: `Bearer ${token}` } })).status).toBe(401);
  });
});
