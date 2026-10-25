import { randomUUID } from "node:crypto";
import { createEmailVerificationToken } from "better-auth/api";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { app } from "../app";
import { serverConfig } from "../config";
import { db } from "../db/client";
import { rateLimit, user } from "../db/auth-schema";
import { SocFiles } from "../soc/files";
import { epubFixture } from "../soc/epub.fixture";
import { rm } from "node:fs/promises";

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
    const identity = await native.json();
    expect(identity).toEqual(await browser.json());
    const files = new SocFiles(serverConfig.socDataRoot, identity.user.id);
    try {
      const world = "project-data/accounts/local/profiles/default/worlds/study";
      await files.write(`${world}/world_meta.json`, Buffer.from('{}'), null, true);
      const upload = epubFixture({ "unused.txt": "padding".repeat(100000) });
      expect(upload.length).toBeGreaterThan(512 * 1024);
      const imported = await app.request(`${origin}/api/soc/textbooks/import?world=${world}&name=phone.epub`, {
        method: "POST", headers: { Authorization: `Bearer ${token}` }, body: new Uint8Array(upload),
      });
      expect(imported.status).toBe(201);
      expect(await imported.json()).toMatchObject({ format: "epub", numPages: 2 });
    } finally { await rm(files.root, { recursive: true, force: true }); }
    const unsigned = decodeURIComponent(token!).split(".")[0];
    expect((await app.request(`${origin}/api/soc/session`, { headers: { Authorization: `Bearer ${unsigned}` } })).status).toBe(401);
    const signout = await app.request(`${origin}/api/auth/sign-out`, { method: "POST", headers: { ...headers, Authorization: `Bearer ${token}` }, body: "{}" });
    expect(signout.status).toBe(200);
    expect((await app.request(`${origin}/api/soc/session`, { headers: { Authorization: `Bearer ${token}` } })).status).toBe(401);
  });
});
