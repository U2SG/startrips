import { isMediaPresentationStyle, type MediaPresentationStyle } from "./mediaPresentationStyle";

export const MEDIA_PRESENTATION_PREFERENCE_PATH = "/api/account-preferences/media-presentation";

export async function requestMediaPresentationPreference(
  style?: MediaPresentationStyle,
  signal?: AbortSignal,
  request: typeof fetch = fetch,
): Promise<MediaPresentationStyle> {
  const response = await request(MEDIA_PRESENTATION_PREFERENCE_PATH, {
    method: style === undefined ? "GET" : "PUT",
    credentials: "include",
    signal,
    ...(style === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ style }) }),
  });
  if (!response.ok) throw new Error(style === undefined ? "无法读取媒体呈现设置，请重试。" : "无法确认媒体呈现设置已保存，请重试。");
  const body = await response.json() as { style?: unknown } | null;
  if (!isMediaPresentationStyle(body?.style)) throw new Error("无法确认媒体呈现设置，请重试。");
  return body.style;
}
