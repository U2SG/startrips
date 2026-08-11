import { useEffect, useState } from "react";
import { IconLoader2 } from "@tabler/icons-react";
import type { UploadDraft } from "../experience/types";

interface GenerationProgressProps {
  draft: UploadDraft;
  deterministic?: boolean;
  reduceMotion?: boolean;
}

const stages = [
  "整理图像的边界",
  "连接时间与地点",
  "生成个人光色",
  "把坐标放回艺术地球",
];

export function GenerationProgress({
  draft,
  deterministic = false,
  reduceMotion = false,
}: GenerationProgressProps) {
  const [stage, setStage] = useState(deterministic ? 2 : 0);

  useEffect(() => {
    if (deterministic || reduceMotion) return;
    const interval = window.setInterval(() => {
      setStage((current) => Math.min(stages.length - 1, current + 1));
    }, 580);
    return () => window.clearInterval(interval);
  }, [deterministic, reduceMotion]);

  return (
    <section className="generation-progress" aria-live="polite">
      <div className="generation-progress__index">001 · PERSONAL RECORD</div>
      <div className="generation-progress__copy">
        <IconLoader2 className="generation-progress__spinner" size={20} stroke={1.1} aria-hidden="true" />
        <h1>打开你的个人光域</h1>
        <p>{stages[stage]}</p>
        <div className="generation-progress__bar" aria-label={`生成进度 ${stage + 1}/${stages.length}`}>
          {stages.map((item, index) => (
            <i key={item} className={index <= stage ? "is-active" : ""} />
          ))}
        </div>
      </div>
      <div className="generation-progress__record">
        <span>{draft.place || "UNKNOWN PLACE"}</span>
        <strong>{draft.title || "UNTITLED MOMENT"}</strong>
        <span>{draft.year || "YEAR UNKNOWN"}</span>
      </div>
    </section>
  );
}
