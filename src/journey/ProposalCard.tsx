import { useEffect, useRef, useState } from "react";
import { IconCheck, IconCopy } from "@tabler/icons-react";
import { StartripsJourneyCue } from "../brand/StartripsBrandMark";
import type { AtlasMutations } from "./atlasView";
import {
  commandBarExpiryLabel,
  commandBarManualEntry,
  commandBarShareJourneys,
  type CommandShareExpiry,
} from "./commandBarModel";
import type { AssignMediaTarget } from "./journeyApi";
import type { RouteOrderIntentPoint, RouteOrderPreviewRow } from "./routeOrderIntent";
import {
  collectShareMediaFilter,
  formatShareExpiry,
  resolveShareExpiry,
  SHARE_BEARER_NOTICE,
  SHARE_TOKEN_ONCE_NOTICE,
  shareLinkUrl,
  shareMediaFilterErrorMessage,
  type ShareMediaFilterProgress,
} from "./shareLinks";
import type { Journey } from "./types";

/**
 * The open Composer's half of a route-order card: the draft as sent, a
 * preview against the draft as it is now, and an apply that answers its own
 * 撤销. All three run inside the Composer, against its live draft.
 */
export type CommandBarComposerBridge = {
  points: () => RouteOrderIntentPoint[];
  preview: (
    basis: readonly RouteOrderIntentPoint[],
    order: readonly string[],
  ) => { rows: RouteOrderPreviewRow[]; notes: string[] } | null;
  apply: (
    basis: readonly RouteOrderIntentPoint[],
    order: readonly string[],
  ) => { undo: () => boolean } | null;
};

/**
 * The open Story's half of an assign-photos card: registered only while its
 * overview is selecting media to move. `apply` and `undo` run the Story's own
 * move and 撤销 (selection, refresh and the stale-undo reconcile stay there);
 * the card never calls the media API itself.
 */
export type CommandBarStoryBridge = {
  journeyId: string;
  /** Read at submit and again at confirm. */
  selectionCount: () => number;
  /** `changed`: the selection is no longer the one the sentence was about. */
  apply: (targetRoutePointId: string | null, expected: { journeyId: string; selectionCount: number }) =>
    Promise<"moved" | "changed" | "failed">;
  /** `none`: nothing left to undo (already undone, or the selection mode ended). */
  undo: () => Promise<"undone" | "stale" | "failed" | "none">;
};

/** What 修改 hands the share dialog. */
export type ShareDialogPrefill = {
  journeyIds: string[];
  expiry: CommandShareExpiry;
  /** Ready photos, a filter still to run, or every media. */
  mediaFilter: { assetIds: string[]; excludedCount: number } | "request" | null;
};

export type ProposalCardModel =
  | {
    kind: "share";
    filter: boolean;
    journeyIds: string[];
    expiry: CommandShareExpiry;
    unmatched: string | null;
  }
  | {
    kind: "route-order";
    basis: RouteOrderIntentPoint[];
    order: string[];
    rows: RouteOrderPreviewRow[];
    notes: string[];
    unmatched: string | null;
  }
  | {
    kind: "assign-photos";
    journeyId: string;
    selectionCount: number;
    /** The proposed target first, then the alternatives the member may pick. */
    targets: AssignMediaTarget[];
    unmatched: string | null;
  }
  | { kind: "create-journey"; sentence: string }
  | { kind: "navigate"; journeyId: string; unmatched: string | null }
  | { kind: "globe-focus" }
  /** Nothing to confirm: what was not understood, and where to do it by hand. */
  | { kind: "note"; text: string; manual: string };

export type ProposalCardProps = {
  card: ProposalCardModel;
  journeys: readonly Journey[];
  shareClient: Pick<AtlasMutations, "createShare" | "proposeShareMedia" | "readShareMediaPreview"> | null;
  composerBridge: { current: CommandBarComposerBridge | null };
  storyBridge: { current: CommandBarStoryBridge | null };
  onCreateJourney: (sentence: string) => void;
  onEditShare: (prefill: ShareDialogPrefill) => void;
  onNavigate: (journeyId: string) => void;
  onGlobeFocus: () => void;
  /** 修改 without a dialog: the sentence goes back into the bar. */
  onRevise: () => void;
  onDismiss: () => void;
  /** Told while a confirm is in flight, so Escape cannot hide its outcome. */
  onWorkingChange?: (working: boolean) => void;
};

type MediaFilter =
  | { status: "pending"; progress: ShareMediaFilterProgress | null }
  | { status: "ready"; assetIds: string[]; excludedCount: number }
  | { status: "error"; text: string }
  | { status: "unavailable" };

type Outcome =
  | { status: "idle" }
  | { status: "working" }
  | { status: "done"; text: string }
  | { status: "failed"; text: string }
  | { status: "created"; url: string; expiresAt: string; journeyCount: number; mediaCount: number | null }
  | { status: "applied"; undo: () => boolean }
  /** The Story moved the selection; 撤销 runs the Story's own undo. */
  | { status: "moved"; label: string; undoing: boolean; text: string | null };

const MAX_THUMBNAILS = 12;

function cardTitle(card: ProposalCardModel, journeys: readonly Journey[]) {
  switch (card.kind) {
    case "share": return card.filter ? "只分享风景照" : "创建分享链接";
    case "route-order": return "调整途径点顺序";
    case "assign-photos": return `把 ${card.selectionCount} 张移到`;
    case "create-journey": return "记录一段新旅程";
    case "navigate": {
      const journey = journeys.find((candidate) => candidate.id === card.journeyId);
      return journey ? `打开「${journey.title}」` : "打开旅程";
    }
    case "globe-focus": return "只看地球";
    case "note": return "没有可以确认的操作";
  }
}

/**
 * One card per reply: 确认 / 修改 / 取消. Enter on the card confirms, Esc
 * (handled by the bar) dismisses it, Tab moves between its buttons. Every
 * confirm reuses an existing path; nothing is written before it.
 */
export function ProposalCard({
  card,
  journeys,
  shareClient,
  composerBridge,
  storyBridge,
  onCreateJourney,
  onEditShare,
  onNavigate,
  onGlobeFocus,
  onRevise,
  onDismiss,
  onWorkingChange,
}: ProposalCardProps) {
  const rootRef = useRef<HTMLElement | null>(null);
  const confirmRef = useRef<HTMLButtonElement | null>(null);
  const [outcome, setOutcome] = useState<Outcome>({ status: "idle" });
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const shareFilter = card.kind === "share" && card.filter;
  const [media, setMedia] = useState<MediaFilter | null>(
    shareFilter ? { status: "pending", progress: null } : null,
  );
  const [thumbnails, setThumbnails] = useState<Array<{ id: string; url: string }>>([]);
  const [targetIndex, setTargetIndex] = useState(0);
  const chosenTarget = card.kind === "assign-photos" ? card.targets[targetIndex] ?? card.targets[0] : null;
  const title = card.kind === "assign-photos" && chosenTarget
    ? `把 ${card.selectionCount} 张移到 · ${chosenTarget.label}`
    : cardTitle(card, journeys);
  const shareJourneys = card.kind === "share" ? commandBarShareJourneys(card, journeys) : [];

  // A globe-focus card is one Enter away; the others take focus as a whole.
  useEffect(() => {
    if (card.kind === "globe-focus") confirmRef.current?.focus({ preventScroll: true });
    else rootRef.current?.focus({ preventScroll: true });
  }, [card]);

  // "只分享风景照": the share dialog's batched check (skips, progress,
  // supersede) runs before confirm is allowed. A run belongs to its sequence
  // number, so a retry or an unmount drops late answers; a remount of the
  // same instance (React's development double effect) keeps the run going
  // instead of restarting it without the skips gathered so far.
  const mountedRef = useRef(false);
  const mediaSequence = useRef(0);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  async function startMediaFilter() {
    const propose = shareClient?.proposeShareMedia;
    if (!propose) {
      setMedia({ status: "unavailable" });
      return;
    }
    const sequence = mediaSequence.current + 1;
    mediaSequence.current = sequence;
    const isCurrent = () => mountedRef.current && sequence === mediaSequence.current;
    setMedia({ status: "pending", progress: null });
    setThumbnails([]);
    const journeyIds = shareJourneys.map((journey) => journey.id);
    let result;
    try {
      result = await collectShareMediaFilter(journeyIds, propose, {
        isCurrent,
        onProgress: (progress) => { if (isCurrent()) setMedia({ status: "pending", progress }); },
      });
    } catch (error) {
      if (isCurrent()) setMedia({ status: "error", text: shareMediaFilterErrorMessage(error) });
      return;
    }
    if (!result || !isCurrent()) return;
    setMedia({ status: "ready", assetIds: result.assetIds, excludedCount: result.excludedCount });
    const readPreview = shareClient?.readShareMediaPreview;
    if (!readPreview) return;
    const reads = await Promise.all(result.assetIds.slice(0, MAX_THUMBNAILS).map(async (id) => {
      try {
        const read = await readPreview(id);
        return { id, url: read.preview?.url ?? read.url };
      } catch {
        return null;
      }
    }));
    if (isCurrent()) setThumbnails(reads.filter((read): read is { id: string; url: string } => read !== null));
  }

  useEffect(() => {
    if (!shareFilter || mediaSequence.current > 0) return;
    void startMediaFilter();
    // The card is replaced (keyed), never updated, so it runs once per card.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const confirmable = (() => {
    if (outcome.status !== "idle" && outcome.status !== "failed") return false;
    if (card.kind === "note") return false;
    if (card.kind === "share") {
      return shareClient !== null && shareJourneys.length > 0 && (!card.filter || media?.status === "ready");
    }
    return true;
  })();

  async function confirm() {
    if (!confirmable) return;
    switch (card.kind) {
      case "share": {
        if (!shareClient) return;
        const expiry = resolveShareExpiry(card.expiry, new Date());
        if (!expiry.ok) return;
        const mediaAssetIds = card.filter && media?.status === "ready" ? media.assetIds : undefined;
        setOutcome({ status: "working" });
        try {
          const created = await shareClient.createShare(
            shareJourneys.map((journey) => journey.id),
            expiry.expiresAt,
            mediaAssetIds,
          );
          setOutcome({
            status: "created",
            url: shareLinkUrl(window.location.origin, created.token),
            expiresAt: created.share.expiresAt,
            journeyCount: created.share.journeyCount,
            mediaCount: mediaAssetIds ? mediaAssetIds.length : null,
          });
        } catch (error) {
          setOutcome({
            status: "failed",
            text: error instanceof Error && error.message ? error.message : "创建分享链接失败，请重试。",
          });
        }
        return;
      }
      case "assign-photos": {
        const bridge = storyBridge.current;
        if (!chosenTarget) return;
        if (!bridge) {
          setOutcome({ status: "failed", text: "故事里的选择已经结束，这次的建议已作废，请重新选择照片。" });
          return;
        }
        setOutcome({ status: "working" });
        const result = await bridge.apply(chosenTarget.routePointId, {
          journeyId: card.journeyId,
          selectionCount: card.selectionCount,
        });
        setOutcome(result === "moved"
          ? { status: "moved", label: chosenTarget.label, undoing: false, text: null }
          : {
            status: "failed",
            text: result === "changed"
              ? "所选照片在等待期间有变化，这次的建议已作废，请重新描述。"
              : "没能移动这些照片，原因见故事里的提示；可以重试。",
          });
        return;
      }
      case "route-order": {
        const applied = composerBridge.current?.apply(card.basis, card.order) ?? null;
        setOutcome(applied
          ? { status: "applied", undo: applied.undo }
          : { status: "failed", text: "路线在等待期间改动过，这次的建议已作废，请重新描述。" });
        return;
      }
      case "create-journey":
        onCreateJourney(card.sentence);
        return;
      case "navigate":
        onNavigate(card.journeyId);
        return;
      case "globe-focus":
        onGlobeFocus();
        return;
    }
  }

  async function undoMove() {
    if (outcome.status !== "moved" || outcome.undoing) return;
    const moved = outcome;
    const bridge = storyBridge.current;
    if (!bridge) {
      setOutcome({ status: "done", text: "故事里的选择已经结束，这次移动无法再从这里撤销。" });
      return;
    }
    setOutcome({ ...moved, undoing: true });
    const result = await bridge.undo();
    if (result === "failed") {
      // The Story keeps a retryable undo; 撤销 stays here for another try.
      setOutcome({ ...moved, undoing: false, text: "撤销失败，可以再试一次。" });
      return;
    }
    setOutcome({
      status: "done",
      text: result === "undone"
        ? "已撤销，照片回到原来的位置。"
        : result === "stale"
          ? "照片之后又有变动，无法撤销；已按服务器上的状态更新。"
          : "这次移动已经撤销或结束，无法再撤销。",
    });
  }

  function revise() {
    if (card.kind === "share") {
      onEditShare({
        journeyIds: shareJourneys.map((journey) => journey.id),
        expiry: card.expiry,
        mediaFilter: !card.filter
          ? null
          : media?.status === "ready"
            ? { assetIds: media.assetIds, excludedCount: media.excludedCount }
            : "request",
      });
      return;
    }
    onRevise();
  }

  async function copy(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      setCopyFailed(true);
    }
  }

  const working = outcome.status === "working" || (outcome.status === "moved" && outcome.undoing);
  useEffect(() => {
    onWorkingChange?.(working);
  }, [onWorkingChange, working]);

  return (
    <section
      ref={rootRef}
      className="command-card motion-fade-through"
      tabIndex={-1}
      aria-label={title}
      data-command-card={card.kind}
      onKeyDown={(event) => {
        if (event.key === "Enter" && event.target === event.currentTarget) {
          event.preventDefault();
          void confirm();
        }
      }}
    >
      <h3>{title}</h3>

      {card.kind === "share" ? (
        <>
          {shareJourneys.length > 0 ? (
            <ol className="command-card__list">
              {shareJourneys.map((journey) => (
                <li key={journey.id}><strong>{journey.title}</strong><small>{journey.startedOn}</small></li>
              ))}
            </ol>
          ) : <p>这句话没有对应到任何旅程。{commandBarManualEntry("share")}</p>}
          <p className="command-card__meta">{commandBarExpiryLabel(card.expiry)}</p>
          {media?.status === "pending" ? (
            <p className="command-card__status" role="status" data-command-media-filter="pending">
              <StartripsJourneyCue state="waiting" size={28} />
              {media.progress
                ? `正在挑选不含人物的照片（已检查 ${media.progress.checked} / ${media.progress.total}）`
                : "正在挑选不含人物的照片，照片较多时需要一点时间…"}
            </p>
          ) : null}
          {media?.status === "ready" ? (
            <>
              <p className="command-card__status" data-command-media-filter="ready">
                将分享 {media.assetIds.length} 张风景照（已排除 {media.excludedCount} 张含人物或无法确认的照片与视频）
              </p>
              {thumbnails.length > 0 ? (
                <ul className="command-card__strip" aria-label="将分享的风景照">
                  {thumbnails.map((thumbnail) => (
                    <li key={thumbnail.id}><img src={thumbnail.url} alt="" loading="lazy" decoding="async" /></li>
                  ))}
                </ul>
              ) : null}
            </>
          ) : null}
          {media?.status === "error" ? (
            <div className="command-card__status" role="alert" data-command-media-filter="error">
              <p>{media.text}</p>
              <button type="button" onClick={() => void startMediaFilter()}>重新挑选</button>
            </div>
          ) : null}
          {media?.status === "unavailable" ? (
            <p className="command-card__status" data-command-media-filter="unavailable">这台服务器不能按照片内容筛选。可以点「修改」改为分享全部照片。</p>
          ) : null}
        </>
      ) : null}

      {card.kind === "route-order" ? (
        <>
          <ol className="command-card__list" aria-label="新顺序预览">
            {card.rows.map((row) => (
              <li key={row.draftId} data-route-order-moved={row.moved ? "true" : undefined}>
                <strong>{row.to}. {row.label}</strong>
                {row.moved ? <small>原第 {row.from} 个</small> : null}
              </li>
            ))}
          </ol>
          {card.notes.length > 0 ? (
            <ul className="command-card__notes">{card.notes.map((note) => <li key={note}>{note}</li>)}</ul>
          ) : null}
        </>
      ) : null}

      {card.kind === "assign-photos" && card.targets.length > 1 ? (
        <div className="command-card__choices" role="group" aria-label="也可能是这些位置">
          {card.targets.map((target, index) => (
            <button
              key={target.routePointId ?? "journey"}
              type="button"
              aria-pressed={index === targetIndex}
              disabled={outcome.status !== "idle" && outcome.status !== "failed"}
              onClick={() => setTargetIndex(index)}
            >{target.label}</button>
          ))}
        </div>
      ) : null}

      {card.kind === "create-journey" ? (
        <>
          <blockquote className="command-card__quote">{card.sentence}</blockquote>
          <p className="command-card__meta">确认后打开「记录旅程」，先读出地点和日期给你核对，确认后才加入路线。</p>
        </>
      ) : null}

      {card.kind === "navigate" ? (
        <p className="command-card__meta">
          {journeys.find((journey) => journey.id === card.journeyId)?.startedOn ?? ""}
        </p>
      ) : null}

      {card.kind === "globe-focus" ? (
        <p className="command-card__meta">隐藏界面，只看地球；按 Esc 退出。</p>
      ) : null}

      {card.kind === "note" ? (
        <p>{card.text}<span className="command-card__meta">{card.manual}</span></p>
      ) : null}

      {"unmatched" in card && card.unmatched ? <p className="command-card__meta">{card.unmatched}</p> : null}

      {outcome.status === "failed" ? <p className="command-card__status" role="alert">{outcome.text}</p> : null}

      {outcome.status === "created" ? (
        <div className="command-card__created" data-command-share-created="true">
          <p>
            链接有效至 <strong data-share-expires-at={outcome.expiresAt}>{formatShareExpiry(outcome.expiresAt)}</strong>
            ，包含 {outcome.journeyCount} 段旅程
            {outcome.mediaCount !== null ? `，只分享其中 ${outcome.mediaCount} 张风景照` : null}
          </p>
          <output className="command-card__link" data-share-link="true">{outcome.url}</output>
          <p className="command-card__meta">{SHARE_BEARER_NOTICE}</p>
          <p className="command-card__meta">{SHARE_TOKEN_ONCE_NOTICE}</p>
          {copyFailed ? <p className="command-card__status" role="alert">复制失败，请手动选择链接文本。</p> : null}
          <div className="command-card__actions">
            <button type="button" onClick={() => void copy(outcome.url)}>
              {copied ? <IconCheck size={16} stroke={1.35} aria-hidden="true" /> : <IconCopy size={16} stroke={1.35} aria-hidden="true" />}
              {copied ? "已复制链接" : "复制链接"}
            </button>
            <button type="button" onClick={onDismiss}>完成</button>
          </div>
        </div>
      ) : null}

      {outcome.status === "applied" ? (
        <div className="command-card__actions" data-command-route-order="applied">
          <p className="command-card__status" role="status">已应用新顺序，保存后生效。</p>
          <button
            type="button"
            onClick={() => {
              setOutcome(outcome.undo()
                ? { status: "done", text: "已撤销，路线恢复原来的顺序。" }
                : { status: "done", text: "路线之后又改动过，无法撤销；可以在路线列表里逐个移动。" });
            }}
          >撤销</button>
          <button type="button" onClick={onDismiss}>完成</button>
        </div>
      ) : null}

      {outcome.status === "moved" ? (
        <div className="command-card__actions" data-command-assign-photos="moved">
          <p className="command-card__status" role="status">{outcome.text ?? `已移动到 ${outcome.label}`}</p>
          <button type="button" disabled={outcome.undoing} onClick={() => void undoMove()}>
            {outcome.undoing ? <StartripsJourneyCue state="waiting" size={24} /> : null}
            {outcome.undoing ? "正在撤销…" : "撤销"}
          </button>
          <button type="button" disabled={outcome.undoing} onClick={onDismiss}>完成</button>
        </div>
      ) : null}

      {outcome.status === "done" ? <p className="command-card__status" role="status">{outcome.text}</p> : null}

      {outcome.status === "idle" || outcome.status === "working" || outcome.status === "failed" ? (
        <div className="command-card__actions">
          {card.kind !== "note" ? (
            <button
              ref={confirmRef}
              type="button"
              className="command-card__confirm"
              disabled={!confirmable}
              onClick={() => void confirm()}
            >
              {working ? <StartripsJourneyCue state="waiting" size={24} /> : null}
              {working ? (card.kind === "assign-photos" ? "正在移动…" : "正在创建…") : "确认"}
            </button>
          ) : null}
          <button type="button" disabled={working} onClick={revise}>修改</button>
          <button type="button" disabled={working} onClick={onDismiss}>取消</button>
        </div>
      ) : null}
    </section>
  );
}
