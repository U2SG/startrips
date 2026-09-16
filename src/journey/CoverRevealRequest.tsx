import { useEffect, useId, useRef, useState } from "react";
import { IconPhotoStar } from "@tabler/icons-react";
import { JourneyApiError, type enqueueCoverReveal } from "./journeyApi";
import type { JourneyMediaAsset } from "./types";
import "./coverRevealRequest.css";

const errors: Record<string, string> = {
  SOURCE_IDENTITY_UNVERIFIED: "这张历史封面尚未完成原图验证，暂时无法生成。",
  SOURCE_UNSUPPORTED: "暂时仅支持 JPEG、PNG 和 WebP 图片封面。",
  NO_COVER: "请先为旅程添加图片封面。",
  JOURNEY_UNAVAILABLE: "旅程已不可用，请刷新后重试。",
};

/** Mount with a Journey + cover identity key so old results cannot label a new cover. */
export function CoverRevealRequest({ journeyId, cover, enqueue, disabled }: {
  journeyId: string;
  cover: JourneyMediaAsset;
  enqueue: typeof enqueueCoverReveal;
  disabled: boolean;
}) {
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const busy = useRef(false);
  const mounted = useRef(true);
  const descriptionId = useId();
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const supported = ["image/jpeg", "image/png", "image/webp"].includes(cover.mimeType);

  async function submit() {
    if (disabled || !supported || busy.current) return;
    busy.current = true;
    setPending(true);
    setMessage("");
    try {
      const result = await enqueue(journeyId);
      if (!mounted.current) return;
      if (result.sourceMediaAssetId !== cover.id) {
        setMessage("封面已变化，请刷新旅程后查看当前封面的生成情况。");
      } else {
        setMessage(result.state === "ready"
          ? "当前封面的水墨开场图已生成，原封面保持不变。"
          : result.state === "leased"
            ? "当前封面的水墨开场图正在生成。"
            : result.state === "queued"
              ? "已加入生成队列，等待处理。可以继续浏览旅程。"
              : "生成状态已变化，请稍后重试。");
      }
    } catch (error) {
      if (!mounted.current) return;
      setMessage(error instanceof JourneyApiError
        ? errors[error.code] ?? (error.status === 401
          ? "登录已失效，请重新登录后重试。"
          : error.status === 403
            ? "你没有为此旅程生成开场图的权限。"
            : "暂时无法确认提交结果，请稍后重试；重复提交不会重复创建待处理任务。")
        : "网络连接失败，无法确认提交结果。请稍后重试。");
    } finally {
      busy.current = false;
      if (mounted.current) setPending(false);
    }
  }

  return <section className="cover-reveal-request" aria-label="水墨开场图">
    <button type="button" disabled={disabled || pending || !supported}
      aria-describedby={descriptionId} aria-busy={pending} onClick={() => void submit()}>
      <IconPhotoStar size={16} stroke={1.35} aria-hidden="true" />
      {pending ? "正在提交…" : "生成水墨开场图"}
    </button>
    <p id={descriptionId}>{supported
      ? "基于当前旅程封面生成，不会替换原图。"
      : errors.SOURCE_UNSUPPORTED}</p>
    <p role="status" aria-live="polite">{message}</p>
  </section>;
}
