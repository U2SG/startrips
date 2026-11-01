import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, inArray, lt } from "drizzle-orm";
import { makeSignature } from "better-auth/crypto";
import { Hono, type Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { auth } from "../auth";
import { getAuthoritativeSession } from "../authorization/authoritative-session";
import { serverConfig } from "../config";
import { db } from "../db/client";
import { member, session, verification } from "../db/auth-schema";
import { clientAddress, FixedWindowCounter } from "../share-rate-limit";
import { readJsonObject } from "./json-body";

const base = "/api/native-auth";
const origin = serverConfig.appOrigin;
const flowKind = "startrips.native-google.flow";
const grantKind = "startrips.native-google.grant";
const browserCookie = (serverConfig.production ? "__Host-" : "") + "startrips.native_google";
const callback = "startrips://auth";
const token = () => randomBytes(32).toString("base64url");
const digest = (text: string) => createHash("sha256").update(text).digest("base64url");
const opaque = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_-]{43}$/.test(v);
const key = (kind: string, raw: string) => kind + ":" + digest(raw);
const limiter = new FixedWindowCounter(60_000);

type Principal = { sessionId: string; userId: string; org: string | null };
type Flow = {
  state: string; codeChallenge: string; intent: "sign-in" | "sign-up"; origin: string;
  phase: "new" | "browser" | "oauth" | "review"; browser?: string; proof?: string; principal?: Principal;
};
type Row = typeof verification.$inferSelect;
const rejected = (c: Context) => c.json({ error: "NATIVE_AUTH_UNAVAILABLE" }, 400);
const cookieOptions = { httpOnly: true, secure: true, sameSite: "Lax" as const, path: "/" };
const escape = (text: string) => text.replace(/[&<>"']/g, (x) =>
  ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[x] ?? ""));
const form = (path: string, label: string) =>
  '<form method="post" action="' + base + path + '"><button type="submit">' + label + '</button></form>';
function page(c: Context, title: string, body: string) {
  // A navigation form POST with no-referrer sends Origin: null. Keep the origin but omit the proof query.
  c.header("Referrer-Policy", "origin");
  return c.html('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' +
    title + '</title><main><h1>' + title + '</h1>' + body + '</main></html>');
}
function allowedBody(body: Record<string, unknown> | null, keys: string[]) {
  return body !== null && Object.keys(body).length === keys.length && keys.every((k) => Object.hasOwn(body, k));
}
function live(id: string) {
  return and(eq(verification.id, id), gt(verification.expiresAt, new Date()));
}
async function readFlow(raw: string) {
  const [row] = await db.select().from(verification).where(live(key(flowKind, raw))).limit(1);
  if (!row) return null;
  const data: Flow = JSON.parse(row.value);
  return data.origin === origin ? {row, data} : null;
}
// Exact old value is the state-machine CAS. Tabs, back gestures and repeated posts cannot replay a transition.
async function advance(row: Row, data: Flow) {
  const rows = await db.update(verification).set({value: JSON.stringify(data)})
    .where(and(live(row.id), eq(verification.value, row.value))).returning({id: verification.id});
  return rows.length === 1;
}
async function browserFlow(c: Context) {
  const parts = getCookie(c, browserCookie)?.split(".") ?? [];
  if (parts.length !== 2 || !opaque(parts[0]) || !opaque(parts[1])) return null;
  const flow = await readFlow(parts[0]);
  return flow?.data.browser === digest(parts[1]) ? flow : null;
}
function identify(current: NonNullable<Awaited<ReturnType<typeof getAuthoritativeSession>>>): Principal {
  return {sessionId: current.session.id, userId: current.user.id, org: current.session.activeOrganizationId ?? null};
}
function samePrincipal(a: Principal | undefined, b: Principal) {
  return a?.sessionId === b.sessionId && a.userId === b.userId && a.org === b.org;
}

export const nativeAuthRoutes = new Hono();
nativeAuthRoutes.use("*", async (c, next) => {
  c.header("Cache-Control", "private, no-store");
  c.header("Referrer-Policy", "no-referrer");
  c.header("X-Frame-Options", "DENY");
  c.header("Content-Security-Policy", "default-src 'none'; form-action 'self' https://accounts.google.com startrips:; frame-ancestors 'none'; base-uri 'none'");
  if (!serverConfig.googleClientId || !serverConfig.googleClientSecret) return c.json({error: "PROVIDER_UNAVAILABLE"}, 404);
  if (c.req.method === "POST" && c.req.header("Origin") !== origin) return c.json({error: "ORIGIN_REQUIRED"}, 403);
  await next();
});
nativeAuthRoutes.post("/start", async (c) => {
  if (!limiter.hit(clientAddress(c) ?? "unknown", 30, Date.now())) return c.json({error: "RATE_LIMITED"}, 429);
  const data = await readJsonObject(() => c.req.json());
  if (!data || !allowedBody(data, ["state","codeChallenge","intent"]) || !opaque(data.state) || !opaque(data.codeChallenge) ||
      (data.intent !== "sign-in" && data.intent !== "sign-up")) return rejected(c);
  await db.delete(verification).where(and(inArray(verification.identifier, [flowKind, grantKind]), lt(verification.expiresAt, new Date())));
  const request = token();
  const flow: Flow = {state:data.state, codeChallenge:data.codeChallenge, intent:data.intent, origin, phase:"new"};
  await db.insert(verification).values({id:key(flowKind, request), identifier:flowKind, value:JSON.stringify(flow),
    expiresAt:new Date(Date.now() + 10 * 60_000)});
  return c.json({authorizeUrl: origin + base + "/authorize?request=" + request});
});
nativeAuthRoutes.get("/authorize", async (c) => {
  const id = c.req.query("request");
  if (!opaque(id)) return rejected(c);
  const flow = await readFlow(id), nonce = token();
  if (!flow || flow.data.phase !== "new" || !await advance(flow.row, {...flow.data, phase:"browser",browser:digest(nonce)})) return rejected(c);
  setCookie(c, browserCookie, id + "." + nonce, {...cookieOptions, maxAge:600});
  return page(c, "连接 Startrips iPhone", form("/begin", flow.data.intent === "sign-up" ? "用 Google 注册" : "用 Google 登录") + form("/cancel","取消"));
});
nativeAuthRoutes.post("/begin", async (c) => {
  const f = await browserFlow(c);
  if (!f || f.data.phase !== "browser") return rejected(c);
  const proof = token();
  if (!await advance(f.row, {...f.data, phase:"oauth", proof:digest(proof)})) return rejected(c);
  // Use the normal HTTP endpoint so its state cookie, PKCE, rate limit and explicit sign-up rules all apply.
  const headers = new Headers(c.req.raw.headers);
  headers.delete("authorization"); headers.delete("content-length"); headers.set("content-type","application/json");
  const result = await auth.handler(new Request(origin + "/api/auth/sign-in/social", {
    method:"POST", headers, body:JSON.stringify({provider:"google", disableRedirect:true, requestSignUp:f.data.intent === "sign-up",
      callbackURL:origin + base + "/review?proof=" + proof, errorCallbackURL:origin + base + "/cancelled"}),
  }));
  if (!result.ok) return rejected(c);
  const answer = await result.json() as {url?: string};
  if (!answer.url || new URL(answer.url).origin !== "https://accounts.google.com") return rejected(c);
  for (const value of result.headers.getSetCookie()) c.header("Set-Cookie", value, {append:true});
  return c.redirect(answer.url, 303);
});
nativeAuthRoutes.get("/review", async (c) => {
  const f = await browserFlow(c), proof = c.req.query("proof");
  if (!f || !opaque(proof) || f.data.phase !== "oauth" || f.data.proof !== digest(proof)) return rejected(c);
  const current = await getAuthoritativeSession(c.req.raw.headers);
  if (!current || !await advance(f.row, {...f.data, phase:"review", principal:identify(current)})) return rejected(c);
  return page(c, "允许此 iPhone 登录", '<p>当前账户：' + escape(current.user.email) + '</p>' +
    form("/consent","使用这个账户继续") + form("/cancel","取消"));
});
async function cancel(c: Context) {
  const f = await browserFlow(c);
  if (!f) return rejected(c);
  const deleted = await db.delete(verification).where(and(live(f.row.id),eq(verification.value,f.row.value))).returning({id: verification.id});
  if (!deleted.length) return rejected(c);
  setCookie(c, browserCookie, "", {...cookieOptions,maxAge:0});
  return c.redirect(callback + "?error=access_denied&state=" + f.data.state, 303);
}
nativeAuthRoutes.post("/cancel", cancel);
nativeAuthRoutes.get("/cancelled", cancel);
nativeAuthRoutes.post("/consent", async (c) => {
  const f = await browserFlow(c);
  if (!f || f.data.phase !== "review") return rejected(c);
  const current = await getAuthoritativeSession(c.req.raw.headers);
  if (!current || !samePrincipal(f.data.principal, identify(current))) return rejected(c);
  const code = token();
  const accepted = await db.transaction(async tx => {
    const consumed = await tx.delete(verification).where(and(live(f.row.id),eq(verification.value,f.row.value))).returning({id: verification.id});
    if (!consumed.length) return false;
    const grant = {state:f.data.state, codeChallenge:f.data.codeChallenge, origin, principal:identify(current)};
    await tx.insert(verification).values({id:key(grantKind,code),identifier:grantKind,value:JSON.stringify(grant),expiresAt:new Date(Date.now()+60_000)});
    return true;
  });
  if (!accepted) return rejected(c);
  setCookie(c,browserCookie,"",{...cookieOptions,maxAge:0});
  return c.redirect(callback + "?code=" + code + "&state=" + f.data.state, 303);
});
nativeAuthRoutes.post("/exchange", async (c) => {
  const data = await readJsonObject(() => c.req.json());
  if (!data || !allowedBody(data, ["code","codeVerifier","state"]) || !opaque(data.code) || !opaque(data.state) ||
      typeof data.codeVerifier !== "string" || !/^[A-Za-z0-9._~-]{43,128}$/.test(data.codeVerifier)) return rejected(c);
  const id = key(grantKind,data.code), state = data.state, challenge = digest(data.codeVerifier);
  const account = await db.transaction(async tx => {
    const [row] = await tx.select().from(verification).where(live(id)).for("update");
    if (!row) return null;
    const grant = JSON.parse(row.value) as {state:string;codeChallenge:string;origin:string;principal:Principal};
    if (grant.state !== state || grant.codeChallenge !== challenge || grant.origin !== origin) return null;
    const p = grant.principal;
    const [source] = await tx.select({token:session.token, expiresAt:session.expiresAt,org:session.activeOrganizationId})
      .from(session).where(and(eq(session.id,p.sessionId), eq(session.userId,p.userId),gt(session.expiresAt,new Date()))).for("share");
    if (!source || (source.org ?? null) !== p.org) return null;
    if (p.org) {
      const [membership] = await tx.select({id:member.id}).from(member)
        .where(and(eq(member.organizationId,p.org),eq(member.userId,p.userId))).for("share");
      if (!membership) return null;
    }
    await tx.delete(verification).where(eq(verification.id,id));
    return source;
  });
  if (!account) return rejected(c);
  // The exact same server session binds identity, expiry, active Atlas and revocation to both clients.
  // Better Auth signs session_token as token + "." + base64(HMAC-SHA256); Hono encodes the cookie value.
  const authContext = await auth.$context;
  const signed = account.token + "." + await makeSignature(account.token,authContext.secret);
  setCookie(c,authContext.authCookies.sessionToken.name,signed,{...cookieOptions,expires:account.expiresAt});
  return c.body(null,204);
});
