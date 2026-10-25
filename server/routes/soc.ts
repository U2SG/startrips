import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { auth } from "../auth";
import { serverConfig } from "../config";
import { contentTag, SocError, SocFiles, type SocModel } from "../soc/files";
import { extractStudyPdf } from "../soc/pdf";

type StudyEnvironment = { Variables: { files: SocFiles; user: { id: string; name: string; email: string } } };
export const socRoutes = new Hono<StudyEnvironment>();

socRoutes.use("*", async (context, next) => {
  context.header("Cache-Control", "no-store");
  const session = await auth.api.getSession({ headers: context.req.raw.headers });
  if (!session) return context.json({ error: "AUTH_REQUIRED", message: "请先登录" }, 401);
  // The hint rejects stale tabs; authentication alone still selects the owner.
  const expectedUser = context.req.header("X-Soc-User");
  if (expectedUser && expectedUser !== session.user.id) return context.json({ error: "STUDY_ACCOUNT_CHANGED", message: "账号已切换，请刷新后重试" }, 401);
  const origin = context.req.header("origin");
  if (origin && origin !== serverConfig.appOrigin) return context.json({ error: "ORIGIN_DENIED" }, 403);
  context.set("user", session.user);
  const files = new SocFiles(serverConfig.socDataRoot, session.user.id);
  await files.resolve("", true);
  context.set("files", files);
  await next();
});

socRoutes.use("*", bodyLimit({ maxSize: 128 * 1024 * 1024, onError: (c) => c.json({ error: "STUDY_FILE_TOO_LARGE", message: "文件超过 128 MB" }, 413) }));

socRoutes.onError((error, context) => {
  if (error instanceof SocError) return context.json({ error: error.code, message: error.message }, error.status);
  if (error instanceof SyntaxError) return context.json({ error: "INVALID_JSON", message: "请求格式不正确" }, 400);
  console.error("Study request failed", error.name);
  return context.json({ error: "STUDY_UNAVAILABLE", message: "学习服务暂时不可用，请重试" }, 503);
});

socRoutes.get("/session", (c) => c.json({ user: c.get("user") }));
socRoutes.get("/ping", (c) => c.json({ ok: true, root: "" }));
socRoutes.get("/list", async (c) => c.json({ entries: await c.get("files").list(c.req.query("path") || "") }));

socRoutes.get("/file", async (c) => {
  const relative = c.req.query("path") || "";
  const bytes = await c.get("files").read(relative);
  c.header("ETag", contentTag(bytes));
  const type = relative.endsWith(".pdf") ? "application/pdf" : /\.png$/i.test(relative) ? "image/png"
    : /\.jpe?g$/i.test(relative) ? "image/jpeg" : relative.endsWith(".json") ? "application/json; charset=utf-8" : "text/plain; charset=utf-8";
  const headers = new Headers(c.res.headers);
  headers.set("Content-Type", type);
  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(new Uint8Array(bytes), { headers });
});

socRoutes.put("/file", async (c) => {
  const tag = await c.get("files").write(c.req.query("path") || "", Buffer.from(await c.req.arrayBuffer()), c.req.header("if-match") || null, c.req.header("if-none-match") === "*");
  c.header("ETag", tag);
  return c.json({ ok: true });
});

socRoutes.post("/append", async (c) => {
  const tag = await c.get("files").append(c.req.query("path") || "", Buffer.from(await c.req.arrayBuffer()));
  c.header("ETag", tag);
  return c.json({ ok: true });
});

socRoutes.get("/extract", async (c) => {
  const start = Number(c.req.query("start") || 1);
  const end = Number(c.req.query("end") || start + 18);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end - start > 100) throw new SocError(400, "STUDY_PAGE_RANGE", "请选择有效页码，单次不超过 100 页");
  return c.json(await extractStudyPdf(c.get("files"), c.req.query("path") || "", start, end));
});

socRoutes.get("/models", async (c) => {
  const config = await c.get("files").modelConfig();
  return c.json({ active: config.active, profiles: config.profiles.filter((p) => p.apiKey).map(({ name, model }) => ({ name, model })) });
});

export function studyModelEndpoint(profile: SocModel) {
  let url: URL;
  try { url = new URL(`${profile.baseURL.replace(/\/$/, "")}/chat/completions`); } catch { throw new SocError(503, "STUDY_MODEL_CONFIG", "模型地址无效"); }
  if (url.protocol !== "https:" || url.username || url.password || url.port
    || !/(^|\.)(openai\.com|deepseek\.com|aliyuncs\.com|openrouter\.ai)$/.test(url.hostname)) {
    throw new SocError(503, "STUDY_MODEL_CONFIG", "模型地址不受支持，请检查服务器配置");
  }
  return url;
}

async function modelFor(files: SocFiles, name: unknown) {
  const config = await files.modelConfig();
  const profile = config.profiles.find((p) => p.name === name && p.apiKey);
  if (!profile) throw new SocError(400, "STUDY_MODEL_REQUIRED", "请选择已配置的模型");
  return profile;
}

async function upstreamFetch(url: URL | string, key: string, body: unknown, signal: AbortSignal) {
  const connection = new AbortController();
  const deadline = setTimeout(() => connection.abort(), 180_000);
  try {
    const result = await fetch(url, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify(body), signal: AbortSignal.any([signal, connection.signal]), redirect: "error",
    });
    clearTimeout(deadline);
    if (!result.ok) {
      await result.body?.cancel();
      throw new SocError(503, "STUDY_PROVIDER_UNAVAILABLE", `模型服务返回 ${result.status}，请检查配置后重试`);
    }
    return result;
  } catch (error) {
    if (error instanceof SocError) throw error;
    throw new SocError(503, "STUDY_PROVIDER_UNAVAILABLE", "模型服务连接失败，请稍后重试");
  } finally { clearTimeout(deadline); }
}

socRoutes.post("/llm", async (c) => {
  const body = await c.req.json();
  if (!Array.isArray(body.messages) || !body.messages.length || body.messages.length > 200
    || body.messages.some((m: { role?: unknown; content?: unknown }) => !m || !["system", "user", "assistant"].includes(String(m.role)) || typeof m.content !== "string")) {
    throw new SocError(400, "STUDY_MESSAGES_INVALID", "对话格式不正确");
  }
  const profile = await modelFor(c.get("files"), body.profile);
  const result = await upstreamFetch(studyModelEndpoint(profile), profile.apiKey, {
    model: profile.model, messages: body.messages, stream: body.stream === true,
  }, c.req.raw.signal);
  return new Response(result.body, { headers: { "Content-Type": body.stream === true ? "text/event-stream" : "application/json", "Cache-Control": "no-store", "X-Accel-Buffering": "no" } });
});

async function voiceModel(files: SocFiles) {
  const config = await files.modelConfig();
  return config.profiles.find((p) => p.apiKey && /^https:\/\/dashscope(?:-intl)?\.aliyuncs\.com(?:\/|$)/.test(p.baseURL));
}

socRoutes.get("/voice", async (c) => c.json({ available: !!(await voiceModel(c.get("files"))) }));
socRoutes.post("/voice", async (c) => {
  const profile = await voiceModel(c.get("files"));
  if (!profile) throw new SocError(503, "STUDY_VOICE_UNAVAILABLE", "请先配置语音模型");
  const host = new URL(profile.baseURL).origin;
  const body = await c.req.json();
  const input = body.action === "transcribe"
    ? { model: "qwen3-asr-flash", messages: [{ role: "user", content: [{ type: "input_audio", input_audio: { data: body.audio } }] }] }
    : { model: "qwen3-tts-flash", input: { text: body.text, voice: body.voice, language_type: "Chinese" } };
  if (body.action === "transcribe") {
    if (typeof body.audio !== "string" || !/^data:audio\/(?:m4a|mp4|webm|wav);base64,[A-Za-z0-9+/=]+$/.test(body.audio) || body.audio.length > 6 * 1024 * 1024) throw new SocError(400, "STUDY_AUDIO_INVALID", "录音格式不受支持或过长");
  } else if (body.action !== "synthesize" || typeof body.text !== "string" || !body.text.trim() || body.text.length > 4000 || typeof body.voice !== "string" || !/^[A-Za-z0-9_-]{1,40}$/.test(body.voice)) {
    throw new SocError(400, "STUDY_VOICE_INVALID", "语音内容不正确");
  }
  const endpoint = body.action === "transcribe" ? "/compatible-mode/v1/chat/completions" : "/api/v1/services/aigc/multimodal-generation/generation";
  const result = await upstreamFetch(`${host}${endpoint}`, profile.apiKey, input, c.req.raw.signal);
  const payload = await result.json();
  if (body.action === "transcribe") {
    const content = payload.choices?.[0]?.message?.content;
    return c.json({ text: typeof content === "string" ? content : Array.isArray(content) ? content.map((p: { text?: string }) => p.text || "").join("") : "" });
  }
  const raw = payload.output?.audio?.url;
  if (typeof raw !== "string") throw new SocError(503, "STUDY_VOICE_UNAVAILABLE", "语音生成未返回音频，请重试");
  const url = new URL(raw.replace(/^http:/, "https:"));
  if (url.protocol !== "https:") throw new SocError(503, "STUDY_VOICE_UNAVAILABLE", "音频地址无效");
  return c.json({ url: url.href });
});
