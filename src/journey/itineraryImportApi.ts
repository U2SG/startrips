/**
 * #512: the browser side of the import channel.
 *
 * Pasted text never comes here — `readTextItinerary` reads it in the browser,
 * so the one entry point that needs no provider keeps working on a deployment
 * that has configured none. A link and an image do come here, because reading
 * a page and reading a screenshot are the server's to do: the page fetch is
 * guarded there, and the recognition credential lives there and nowhere else.
 *
 * A failure carries the stage it happened in, unchanged. The panel shows the
 * stage, because "we could not reach the page from here" and "we reached it
 * but could not read a plan out of it" lead a member to different next steps,
 * and neither of them is "your link is invalid".
 */

import type { ItineraryRecognition } from "./itineraryImport";

export type ItineraryImportStage =
  | "source-access"
  | "content-read"
  | "ai-extraction";

export class ItineraryImportError extends Error {
  readonly stage: ItineraryImportStage | null;
  readonly code: string;
  readonly status: number;

  constructor(
    status: number,
    code: string,
    message: string,
    stage: ItineraryImportStage | null,
  ) {
    super(message);
    this.name = "ItineraryImportError";
    this.status = status;
    this.code = code;
    this.stage = stage;
  }
}

export type ItineraryImportCapabilities = {
  recognition: {
    configured: boolean;
    recognizerVersion: string | null;
    timeoutMs: number;
  };
  linkFetch: { configured: boolean; driver: string; timeoutMs: number };
};

type ImportResponse = {
  recognition: Omit<ItineraryRecognition, "sourceKind">;
  sourceRead: { readVia: string; contentType: string | null };
};

async function post(
  body: unknown,
  fetcher: typeof fetch,
  signal?: AbortSignal,
): Promise<ImportResponse> {
  const response = await fetcher("/api/itinerary-import", {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  const payload = await response.json().catch(() => null) as
    | { error?: string; message?: string; stage?: ItineraryImportStage }
    | null;
  if (!response.ok) {
    throw new ItineraryImportError(
      response.status,
      payload?.error ?? "IMPORT_FAILED",
      payload?.message ?? "行程识别暂时无法完成。",
      payload?.stage ?? null,
    );
  }
  return payload as unknown as ImportResponse;
}

export async function readItineraryCapabilities(
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<ItineraryImportCapabilities> {
  const response = await fetcher("/api/itinerary-import/capabilities", {
    credentials: "include",
    signal,
  });
  if (!response.ok) {
    throw new ItineraryImportError(
      response.status,
      "CAPABILITIES_UNAVAILABLE",
      "暂时无法确认这台服务器支持哪些导入方式。",
      null,
    );
  }
  return response.json() as Promise<ItineraryImportCapabilities>;
}

export async function readItineraryFromLink(
  link: string,
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<ItineraryRecognition> {
  const { recognition } = await post({ source: "link", link }, fetcher, signal);
  return { ...recognition, sourceKind: "link" };
}

export async function readItineraryFromImage(
  image: { mimeType: string; base64: string },
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<ItineraryRecognition> {
  const { recognition } = await post({ source: "image", image }, fetcher, signal);
  return { ...recognition, sourceKind: "image" };
}

/**
 * The stage a member is told about. A refusal with no stage is about the
 * request itself, not about any of the three steps, and says so.
 */
export function itineraryImportStageMessage(error: ItineraryImportError): string {
  if (error.stage === "source-access") {
    return `无法从这里打开这个链接（${error.code}）。链接本身可能是好的；先试试图片或粘贴文本。`;
  }
  if (error.stage === "content-read") {
    // A refusal is a content-read outcome too, but the page was never served,
    // so the "opened it and found nothing" sentence would be untrue.
    if (error.code === "ITINERARY_SOURCE_REFUSED") {
      return `对方站点回应了，但没有把这个页面给到这里（${error.code}）。先试试图片或粘贴文本。`;
    }
    return `已经打开了页面，但没读到可用的行程内容（${error.code}）。`;
  }
  if (error.stage === "ai-extraction") {
    return `内容已取得，但这次没能识别成行程（${error.code}）。`;
  }
  return error.message;
}
