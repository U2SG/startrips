/**
 * The command bar's pure rules: which intents a surface offers, how long a
 * wait stays quiet, what each failure says, and what a share proposal shows.
 * The server classifies and proposes; nothing here writes.
 */

import type { CommandIntent, ShareIntentProposal } from "./journeyApi";
import { MAX_ROUTE_ORDER_POINTS, MIN_ROUTE_ORDER_POINTS } from "./routeOrderIntent";
import { MAX_SHARE_JOURNEYS, SHARE_EXPIRY_PRESETS } from "./shareLinks";

/** Nothing is shown for a reply faster than this. */
export const COMMAND_BAR_CUE_DELAY_MS = 300;
/** From here the wait says what it is doing and can be stopped. */
export const COMMAND_BAR_STAGED_DELAY_MS = 2_000;
/** The client's own cap: two provider stages plus their margins. */
export const COMMAND_BAR_TIMEOUT_MS = 65_000;
/** The longest sentence any routed intent accepts (the Composer's own bound). */
export const MAX_COMMAND_TEXT_LENGTH = 500;

export type CommandSurface = "atlas" | "composer" | "share";

export type CommandSurfaceContext = {
  surface: CommandSurface;
  canCreateJourney: boolean;
  canShare: boolean;
  journeyCount: number;
  /** Route Points of the open Composer's draft; ignored elsewhere. */
  composerPointCount: number;
};

/**
 * What the member can ask for here, narrowed to what the server routes. The
 * Composer offers only its own reorder; the share dialog only sharing; the
 * Atlas everything that does not need an open draft.
 */
export function commandBarOfferedIntents(
  routed: readonly CommandIntent[],
  context: CommandSurfaceContext,
): CommandIntent[] {
  const canShare = context.canShare && context.journeyCount > 0;
  const offered = (intent: CommandIntent) => {
    switch (context.surface) {
      case "composer":
        return intent === "route-order"
          && context.composerPointCount >= MIN_ROUTE_ORDER_POINTS
          && context.composerPointCount <= MAX_ROUTE_ORDER_POINTS;
      case "share":
        return canShare && (intent === "share" || intent === "share-photos-filter");
      case "atlas":
        switch (intent) {
          case "create-journey": return context.canCreateJourney;
          case "share":
          case "share-photos-filter": return canShare;
          case "navigate": return context.journeyCount > 0;
          case "globe-focus": return true;
          case "route-order": return false;
        }
    }
    return false;
  };
  return routed.filter(offered);
}

export type CommandBarLatencyStage = "quiet" | "cue" | "staged";

export function commandBarLatencyStage(elapsedMs: number): CommandBarLatencyStage {
  if (elapsedMs < COMMAND_BAR_CUE_DELAY_MS) return "quiet";
  if (elapsedMs < COMMAND_BAR_STAGED_DELAY_MS) return "cue";
  return "staged";
}

/** What a wait says at each point; nothing before the cue delay. */
export function commandBarWaitCopy(elapsedMs: number): string | null {
  if (elapsedMs < COMMAND_BAR_CUE_DELAY_MS) return null;
  if (elapsedMs < COMMAND_BAR_STAGED_DELAY_MS) return "正在理解…";
  if (elapsedMs < 10_000) return "正在判断这句话想做什么…";
  if (elapsedMs < 30_000) return "正在对照你的旅程整理提案…";
  return "仍在等待回答，可以停止后改用手动操作。";
}

/** The closest manual entry for each intent, named as the interface names it. */
export function commandBarManualEntry(intent: CommandIntent | "unsupported" | null): string {
  switch (intent) {
    case "create-journey": return "也可以点顶部的「记录旅程」手动填写。";
    case "share":
    case "share-photos-filter": return "也可以点顶部的「分享多段旅程」手动勾选。";
    case "route-order": return "也可以在路线列表里逐个移动途径点。";
    case "navigate": return "也可以在旅程列表里直接打开。";
    case "globe-focus": return "也可以在「更多」里选择「只看地球」。";
    default: return "可以使用顶部的「记录旅程」「分享多段旅程」或「更多」菜单。";
  }
}

export type CommandBarFailure = {
  text: string;
  /** 503: the deployment no longer routes; refetch and hide the bar. */
  refetchCapabilities: boolean;
};

function errorField(error: unknown, field: "status" | "code"): unknown {
  return typeof error === "object" && error !== null && field in error
    ? (error as Record<string, unknown>)[field]
    : null;
}

/**
 * The server's messages are English diagnostics, so the member is shown a
 * sentence chosen here, by status and code, and each says what still works.
 */
export function commandBarFailure(error: unknown): CommandBarFailure {
  const status = errorField(error, "status");
  const code = errorField(error, "code");
  const manual = commandBarManualEntry(null);
  if (status === 503) {
    return { text: "这台服务器暂时不能理解一句话。" + manual, refetchCapabilities: true };
  }
  if (status === 409) return { text: "正在处理上一张，请稍候再试。", refetchCapabilities: false };
  if (code === "INTENT_TEXT_TOO_LONG" || code === "INVALID_INTENT_ROUTE") {
    return { text: "这句话太长或为空，请用一句短一些的话描述。", refetchCapabilities: false };
  }
  if (code === "INVALID_ROUTE_ORDER_INTENT") {
    return {
      text: "需要至少两个途径点，并用 200 字以内描述新顺序。" + commandBarManualEntry("route-order"),
      refetchCapabilities: false,
    };
  }
  if (status === 504 || code === "INTENT_TIMEOUT") {
    return { text: "理解这句话超时了，请重试。" + manual, refetchCapabilities: false };
  }
  if (status === 502) {
    return { text: "理解服务暂时没有给出可用的回答，请重试。" + manual, refetchCapabilities: false };
  }
  if (status === 401 || status === 403) {
    return { text: "当前账户不能执行这项操作。", refetchCapabilities: false };
  }
  return { text: "暂时无法理解这句话，请重试。" + manual, refetchCapabilities: false };
}

/** Said when the client's own cap ends a wait. */
export const COMMAND_BAR_TIMEOUT_TEXT = "等待太久，已停止。" + commandBarManualEntry(null);

/**
 * A share proposal narrowed to the Journeys this view lists, each once, in
 * list order, never more than one link carries.
 */
export function commandBarShareJourneys<T extends { id: string }>(
  proposal: Pick<ShareIntentProposal, "journeyIds">,
  journeys: readonly T[],
): T[] {
  const proposed = new Set(proposal.journeyIds);
  return journeys.filter((journey) => proposed.has(journey.id)).slice(0, MAX_SHARE_JOURNEYS);
}

export type CommandShareExpiry = NonNullable<ShareIntentProposal["expiry"]>;

/** The share dialog's default when the sentence names no duration. */
export function commandBarShareExpiry(proposal: Pick<ShareIntentProposal, "expiry">): CommandShareExpiry {
  return proposal.expiry ?? "7d";
}

/** The preset's own label, as the share dialog shows it. */
export function commandBarExpiryLabel(expiry: CommandShareExpiry) {
  const preset = SHARE_EXPIRY_PRESETS.find((entry) => entry.id === expiry);
  return `有效期 ${preset?.label ?? expiry}`;
}
