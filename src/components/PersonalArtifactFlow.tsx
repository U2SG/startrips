import { useRef, useState, type ChangeEvent } from "react";
import {
  IconCheck,
  IconMapPin,
  IconPhotoPlus,
  IconRefresh,
} from "@tabler/icons-react";
import { preparePersonalMomentImage } from "../../templates/personal-gallery/preparePersonalMomentImage";
import { coordinatesForPlace } from "../storage/personalMoments";
import { formatLatitude, formatLongitude } from "../scene/geo";
import type { UploadDraft } from "../experience/types";

interface PersonalArtifactFlowProps {
  draft: UploadDraft;
  onDraftChange: (patch: Partial<UploadDraft>) => void;
  onSubmit: () => void;
  onCancel: () => void;
}

const lightColors = [
  { id: "ice", label: "冰川蓝", color: "#79dfff" },
  { id: "aurora", label: "极光青", color: "#6ce5c7" },
  { id: "violet", label: "星云紫", color: "#9e8cff" },
  { id: "warm", label: "晴光金", color: "#f4ce73" },
  { id: "pink", label: "恒星粉", color: "#ef9fb8" },
] as const;

export function PersonalArtifactFlow({
  draft,
  onDraftChange,
  onSubmit,
  onCancel,
}: PersonalArtifactFlowProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState("");
  const selectedColor = draft.lightColor ?? "#f4ce73";
  const hasImage = Boolean(draft.imageUrl);
  const isReady = Boolean(
    draft.imageUrl && draft.title.trim() && draft.year.trim() && draft.place.trim(),
  );

  async function handleImageChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setError("");
    try {
      const prepared = await preparePersonalMomentImage(file);
      const previousUrls = new Set([draft.imageUrl, draft.previewUrl]);
      for (const previousUrl of previousUrls) {
        if (previousUrl?.startsWith("blob:")) {
          URL.revokeObjectURL(previousUrl);
        }
      }
      onDraftChange({
        imageUrl: prepared.previewUrl,
        previewUrl: prepared.thumbnailUrl,
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "图片处理失败，请重试");
    } finally {
      event.target.value = "";
    }
  }

  function verifyPlace() {
    if (!draft.place.trim()) return;
    onDraftChange({ point: coordinatesForPlace(draft.place) });
  }

  return (
    <section className={`personal-flow ${hasImage ? "is-filled" : "is-empty"}`}>
      <div className="personal-flow__topline">
        <span>ART MOMENT · PERSONAL ARCHIVE · 001</span>
        <span>A PLACE FOR YOUR VIEW</span>
      </div>

      <div className="personal-workspace">
        <div className="personal-record">
          <div className="personal-record__label">
            <span>PERSONAL VIEW / NOT PUBLIC</span>
            <strong>001</strong>
          </div>

          <div className={`personal-image-frame ${hasImage ? "has-image" : ""}`}>
            {draft.imageUrl ? (
              <img src={draft.imageUrl} alt="你的个人艺术瞬间预览" />
            ) : (
              <button
                className="upload-target"
                type="button"
                onClick={() => inputRef.current?.click()}
              >
                <span className="upload-target__icon" aria-hidden="true">
                  <IconPhotoPlus size={28} stroke={1.55} />
                </span>
                <span className="upload-target__eyebrow">01 · ADD YOUR VIEW</span>
                <strong>放入一件属于你的艺术</strong>
                <p>它不需要是名作。可以是一张画、一件作品，<br />或某个只属于你的创作。</p>
                <small>JPG / PNG / WEBP · MAX 8 MB</small>
              </button>
            )}
          </div>

          {hasImage ? (
            <div className="personal-record__caption">
              <div>
                <span>MEMORY / CIRCA</span>
                <h1>{draft.title || "untitled moment"}</h1>
                <p>{draft.year ? `约 ${draft.year}` : "年份未定"} — {draft.place || "地点未定"}</p>
              </div>
              <button type="button" onClick={() => inputRef.current?.click()}>
                <IconRefresh size={15} stroke={1.4} />
                更换这件记忆
              </button>
            </div>
          ) : null}

          <input
            ref={inputRef}
            className="visually-hidden"
            type="file"
            accept="image/jpeg,image/png,image/webp"
            onChange={handleImageChange}
          />
          {error ? <p className="personal-flow__error" role="alert">{error}</p> : null}

          <div className="personal-record__footnote">
            <span>AN OPEN POINT</span>
            <p>这里不判断好坏，只留下你真实的观看位置。</p>
          </div>
        </div>

        <aside className="personal-editor" aria-label="个人艺术瞬间信息">
          <div className="personal-editor__profile">Joey ZONE</div>

          <div className="personal-editor__intro">
            <div className="personal-editor__wordmark" aria-hidden="true">
              <span>YOUR</span><span>ART</span><span>VIEW</span>
            </div>
            <h2>带来一件<br />属于你的艺术。</h2>
            <p>它不会被写进艺术史正典，而会成为你观看艺术史的一枚坐标。</p>
          </div>

          {!hasImage ? (
            <div className="personal-editor__waiting">
              <span>01 · 你的艺术</span>
              <strong>WAITING</strong>
              <p>先从左侧放入图像。</p>
            </div>
          ) : (
            <form onSubmit={(event) => { event.preventDefault(); onSubmit(); }}>
              <div className="editor-upload-row">
                <span>01 · 你的艺术</span>
                <strong>IMAGE READY</strong>
              </div>

              <label className="editor-field editor-field--title">
                <span>02 · 它叫什么？</span>
                <input
                  value={draft.title}
                  maxLength={48}
                  placeholder="给这段记忆一个名字"
                  onChange={(event) => onDraftChange({ title: event.target.value })}
                />
              </label>

              <label className="editor-field">
                <span>03 · 你为什么记得它？</span>
                <textarea
                  value={draft.note}
                  maxLength={160}
                  rows={2}
                  placeholder="写下一句只属于你的说明"
                  onChange={(event) => onDraftChange({ note: event.target.value })}
                />
              </label>

              <div className="editor-field">
                <span>04 · 它从哪里出发</span>
                <div className="location-row">
                  <input
                    value={draft.place}
                    maxLength={64}
                    placeholder="城市或地点"
                    onChange={(event) => onDraftChange({ place: event.target.value, point: undefined })}
                    onBlur={verifyPlace}
                  />
                  <button type="button" onClick={verifyPlace} disabled={!draft.place.trim()}>
                    {draft.point ? <IconCheck size={14} /> : <IconMapPin size={14} />}
                    {draft.point ? "已确认" : "确认"}
                  </button>
                </div>
                {draft.point ? (
                  <small>已验证 · {draft.place} · {formatLatitude(draft.point.lat, 2)} · {formatLongitude(draft.point.lon, 2)}</small>
                ) : null}
              </div>

              <label className="editor-field editor-field--year">
                <span>05 · 它属于哪一年</span>
                <input
                  inputMode="numeric"
                  value={draft.year}
                  maxLength={12}
                  placeholder="YYYY"
                  onChange={(event) => onDraftChange({ year: event.target.value })}
                />
              </label>

              <fieldset className="light-selector">
                <legend>06 · 选择你的光色</legend>
                <div>
                  {lightColors.map((light) => (
                    <button
                      key={light.id}
                    className={selectedColor === light.color ? "is-selected" : ""}
                      type="button"
                      aria-label={`选择${light.label}`}
                      aria-pressed={selectedColor === light.color}
                      onClick={() => onDraftChange({ lightColor: light.color })}
                    >
                      <i style={{ backgroundColor: light.color }} aria-hidden="true" />
                      <span>{light.label}</span>
                    </button>
                  ))}
                </div>
              </fieldset>

              <button className="create-point" type="submit" disabled={!isReady}>
                <span>{isReady ? "点击，让它成为一个艺术瞬间" : "完成图像、名称、年份与地点"}</span>
                <small>CLICK TO PLACE YOUR POINT</small>
              </button>
            </form>
          )}

          <button className="personal-editor__cancel" type="button" onClick={onCancel}>返回艺术地球</button>
          <p className="personal-editor__privacy">当前只会成为本页面里的个人艺术瞬间；刷新、关闭或跨设备都不会保留。</p>
        </aside>
      </div>
    </section>
  );
}
