import { useEffect, useId, useRef, useState } from "react";
import { startCoverRevealStatusPolling } from "./coverRevealStatusPolling";
import { IconPhotoStar } from "@tabler/icons-react";
import { JourneyApiError, type enqueueCoverReveal, type CreativeCoverClient, type CreativeCoverStatus } from "./journeyApi";
import { CREATIVE_COVER_RECIPES, creativeCoverRecipe, type CreativeCoverRecipeId } from "../reveal/creativeCoverRecipes";
import { CoverRevealStage } from "../reveal/CoverRevealStage";
import { planCoverRevealOpening } from "./coverRevealOpening";
import type { CoverRevealImagePair, RevealPresetId } from "../reveal/coverRevealFlow";
import type { JourneyMediaAsset } from "./types";
import "./coverRevealRequest.css";

const errors: Record<string, string> = {
  SOURCE_IDENTITY_UNVERIFIED: "这张历史封面尚未完成原图验证，暂时无法生成。",
  SOURCE_UNSUPPORTED: "暂时仅支持 JPEG、PNG 和 WebP 图片封面。",
  NO_COVER: "请先为旅程添加图片封面。",
  JOURNEY_UNAVAILABLE: "旅程已不可用，请刷新后重试。",
  COVER_REVEAL_RECIPE_UNAVAILABLE: "此风格尚未在生成服务启用，未创建任务。",
};
function statusText(status: CreativeCoverStatus | null) {
  const label = creativeCoverRecipe(status?.recipeId)?.title ?? "开场图";
  switch (status?.state) {
    case "ready": return `${label}已生成，原封面保持不变。可以预览开场或导出短片。`;
    case "queued": return `${label}已加入生成队列，可以继续浏览旅程。`;
    case "leased": return `${label}正在生成和审阅。`;
    case "failed": return `${label}生成失败，未发布不合格图片。可以重新生成。`;
    case "unavailable": return "当前封面不可用于生成，请刷新旅程后检查原片。";
    default: return "";
  }
}

/** The parent keys this editor by Journey and verified cover identity. */
export function CoverRevealRequest({ journeyId, cover, enqueue, disabled, client }: {
  journeyId: string; cover: JourneyMediaAsset; enqueue: typeof enqueueCoverReveal;
  disabled: boolean; client?: CreativeCoverClient;
}) {
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const [recipeId, setRecipeId] = useState<CreativeCoverRecipeId>("ink-wash-memory");
  const [recipes, setRecipes] = useState(CREATIVE_COVER_RECIPES.filter((r) => r.id === "ink-wash-memory"));
  const [status, setStatus] = useState<CreativeCoverStatus | null>(null);
  const [preview, setPreview] = useState<{ pair: CoverRevealImagePair; preset: RevealPresetId; revision: number; derivativeId: string } | null>(null);
  const busy = useRef(false), mounted = useRef(false), touched = useRef(false);
  const operation = useRef(0);
  const descriptionId = useId();
  const supported = ["image/jpeg", "image/png", "image/webp"].includes(cover.mimeType);
  const refreshStatus = async () => {
    if (!client) return;
    const request = operation.current;
    const next = await client.readStatus(journeyId);
    if (!mounted.current || request !== operation.current) return;
    if (next.sourceMediaAssetId !== cover.id && next.state !== "unavailable") {
      setMessage("封面已变化，请刷新旅程后查看。"); setStatus(null); return;
    }
    setStatus(next);
    setPreview((current) => next.state === "ready" && next.derivativeId === current?.derivativeId ? current : null);
    if (!touched.current && creativeCoverRecipe(next.recipeId)) setRecipeId(next.recipeId!);
  };
  useEffect(() => {
    mounted.current = true;
    if (client && supported) void (async () => {
      try {
        const available = await client.readRecipes();
        if (!mounted.current) return;
        const ids = new Set(available.recipes.map((r) => r.id));
        setRecipes(CREATIVE_COVER_RECIPES.filter((r) => ids.has(r.id)));
        await refreshStatus();
      } catch { if (mounted.current) setMessage("暂时无法读取生成状态，请点击刷新状态；不会自动重新提交任务。"); }
    })();
    return () => { mounted.current = false; operation.current++; };
  }, [journeyId, cover.id, client, supported]);
  useEffect(() => {
    if (!client || (status?.state !== "queued" && status?.state !== "leased")) return;
    return startCoverRevealStatusPolling(refreshStatus, () => {
      setMessage("暂时无法确认生成进度，请稍后刷新状态。");
    });
  }, [client, journeyId, cover.id, status?.state, status?.derivativeId]);

  async function submit() {
    if (disabled || !supported || busy.current || !recipes.some((r) => r.id === recipeId)) return;
    busy.current = true; setPending(true); setMessage(""); setPreview(null);
    const request = ++operation.current;
    try {
      const result = await enqueue(journeyId, undefined, recipeId);
      if (!mounted.current || request !== operation.current) return;
      if (result.sourceMediaAssetId !== cover.id) setMessage("封面已变化，请刷新旅程后查看当前封面的生成情况。");
      else {
        touched.current = false;
        setStatus({ state: result.state as CreativeCoverStatus["state"], recipeId, sourceMediaAssetId: cover.id, derivativeId: result.id });
        await refreshStatus();
      }
    } catch (error) {
      if (!mounted.current || request !== operation.current) return;
      setMessage(error instanceof JourneyApiError ? errors[error.code] ?? (error.status === 401 || error.status === 403
        ? "登录或访问权限已变化，请重新登录后重试。" : "暂时无法确认提交结果，请刷新状态；重复提交相同风格不会创建重复任务。")
        : "网络连接失败，无法确认提交结果。请刷新状态后重试。");
    } finally { if (request === operation.current) { busy.current = false; if (mounted.current) setPending(false); } }
  }
  async function showPreview() {
    if (!client || busy.current || disabled) return;
    busy.current = true; setPending(true); setMessage("");
    const request = ++operation.current;
    try {
      const payload = await client.readDisplay(journeyId);
      const decision = planCoverRevealOpening({ journeyId, cover, payload, played: new Set(), reducedMotion: false, supersededByIntent: false });
      if (decision.kind !== "open" || !(Date.parse(payload.display?.expiresAt ?? "") > Date.now())) throw new Error("preview_unavailable");
      const original = await client.readSource(cover.id);
      if (!(Date.parse(original.expiresAt) > Date.now())) throw new Error("preview_unavailable");
      if (mounted.current && request === operation.current) setPreview({
        pair: { generatedFirst: decision.generatedUrl, originalCover: original.url }, preset: decision.preset, revision: request, derivativeId: payload.derivative!.id,
      });
    } catch { if (mounted.current && request === operation.current) setMessage("暂时无法预览当前封面，请刷新状态后重试。"); }
    finally { if (request === operation.current) { busy.current = false; if (mounted.current) setPending(false); } }
  }
  const selected = creativeCoverRecipe(recipeId)!;
  const unchangedReady = status?.state === "ready" && status.recipeId === recipeId;
  return <section className="cover-reveal-request" aria-label="艺术开场图">
    <label>开场风格<select aria-label="开场风格" value={recipeId} disabled={disabled || pending || !supported}
      onChange={(event) => { touched.current = true; setRecipeId(event.target.value as CreativeCoverRecipeId); setPreview(null); setMessage(""); }}>
      {recipes.map((recipe) => <option key={recipe.id} value={recipe.id}>{recipe.title}</option>)}
    </select></label>
    <button type="button" disabled={disabled || pending || !supported || unchangedReady || !recipes.some((r) => r.id === recipeId)}
      aria-describedby={descriptionId} aria-busy={pending} onClick={() => void submit()}>
      <IconPhotoStar size={16} stroke={1.35} aria-hidden="true" />
      {pending ? "正在处理…" : recipeId === "ink-wash-memory" ? "生成水墨开场图" : `生成${selected.title}开场图`}
    </button>
    <p id={descriptionId}>{supported ? "基于当前封面生成独立开场图，不会替换原图。切换风格并生成后，旧风格的任务会被替代。" : errors.SOURCE_UNSUPPORTED}</p>
    <p role="status" aria-live="polite">{message || statusText(status)}</p>
    {client ? <button type="button" disabled={pending || disabled} onClick={() => {
      setMessage(""); void refreshStatus().catch(() => { if (mounted.current) setMessage("读取状态失败，请稍后重试。"); });
    }}>刷新生成状态</button> : null}
    {client && unchangedReady ? <button type="button" disabled={pending || disabled} onClick={() => void showPreview()}>预览开场</button> : null}
    {preview ? <div className="cover-reveal-request__preview"><CoverRevealStage pair={preview.pair} preset={preview.preset} revision={preview.revision} fit="contain" /></div> : null}
  </section>;
}
