import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { StartripsJourneyCue } from "../brand/StartripsBrandMark";
import {
  IconCheck,
  IconCopy,
  IconLink,
  IconShare,
  IconX,
} from "@tabler/icons-react";
import type { AtlasMutations } from "./atlasView";
import {
  MAX_SHARE_JOURNEYS,
  SHARE_BEARER_NOTICE,
  SHARE_EXPIRY_PRESETS,
  SHARE_TOKEN_ONCE_NOTICE,
  activeShareRows,
  collectShareMediaFilter,
  formatShareExpiry,
  maxCustomExpiry,
  nextShareExpiryDelay,
  resolveShareExpiry,
  sameShareSelection,
  shareExpiryMessage,
  shareLinkUrl,
  shareMediaFilterErrorMessage,
  shareSelectionMessage,
  toDateTimeLocalValue,
  toggleShareSelection,
  type ShareExpiryPresetId,
  type ShareLinkRow,
  type ShareMediaFilterProgress,
} from "./shareLinks";
import { useModalFocus } from "./useModalFocus";
import type { ShareDialogPrefill } from "./ProposalCard";
import type { Journey, ShareGrantSummary } from "./types";

/**
 * #200 phase E: the owner's share surface.
 *
 * One dialog serves both entry paths, because the model behind them is one
 * model: sharing a single Journey is a selection of size one. `lockedJourneyId`
 * is the difference — set, the selection is fixed to that Journey and the list
 * is not offered; null, the owner picks the set.
 *
 * Every share call arrives through `mutations`, never through an import of the
 * API client, so a tree without owner mutations cannot render a working share
 * control even if this component were mounted there by accident.
 */
export type JourneyShareDialogProps = {
  journeys: readonly Journey[];
  lockedJourneyId: string | null;
  mutations: Pick<
    AtlasMutations,
    | "createShare"
    | "listShares"
    | "revokeShare"
    | "proposeShareMedia"
    | "readShareMediaPreview"
  >;
  onClose: () => boolean | void;
  onMutationPendingChange?: (pending: boolean) => void;
  /**
   * A command-bar card's 修改: the proposed selection, expiry and photo
   * filter, for the owner to change before creating the link here.
   */
  prefill?: ShareDialogPrefill | null;
  /** Injected by the tests; the browser passes nothing. */
  now?: () => Date;
  origin?: string;
};

type CreatedLink = {
  url: string;
  expiresAt: string;
  journeyCount: number;
  /** Set only for a link created with the no-people media filter. */
  mediaCount: number | null;
};

/**
 * "只分享风景图". `null` means no filter: the link shares every media of the
 * selected Journeys, exactly as without a filter.
 */
type MediaFilterState =
  | { status: "pending"; journeyIds: string[]; progress: ShareMediaFilterProgress | null }
  | { status: "error"; journeyIds: string[]; text: string }
  // The card asked to leave people out but this server cannot look:
  // Create waits until the owner explicitly chooses to share everything.
  | { status: "unavailable" }
  // `journeyIds` is the selection the answer was judged for; Create refuses
  // it for any other selection.
  | { status: "ready"; journeyIds: string[]; assetIds: string[]; excludedCount: number };

type MediaThumbnail = { id: string; url: string };

/** A strip, not a browser: the count above already says how many. */
const MAX_MEDIA_THUMBNAILS = 12;

const MEDIA_FILTER_CLEARED_BY_SELECTION = "旅程选择已改动，照片筛选已取消，将分享所选旅程的全部照片与视频。";
const MEDIA_FILTER_REMOVED = "已取消照片筛选，将分享所选旅程的全部照片与视频。";

type Phase = "compose" | "created";


export function JourneyShareDialog({
  journeys,
  lockedJourneyId,
  mutations,
  onClose,
  onMutationPendingChange,
  prefill = null,
  now = () => new Date(),
  origin,
}: JourneyShareDialogProps) {
  const listedPrefill = useMemo(() => {
    if (!prefill || lockedJourneyId) return [];
    const listed = new Set(journeys.map((journey) => journey.id));
    return [...new Set(prefill.journeyIds)].filter((id) => listed.has(id)).slice(0, MAX_SHARE_JOURNEYS);
    // The prefill is read once, as the dialog opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [selected, setSelected] = useState<string[]>(
    lockedJourneyId ? [lockedJourneyId] : listedPrefill,
  );
  const [presetId, setPresetId] = useState<ShareExpiryPresetId>(prefill?.expiry ?? "7d");
  const [customValue, setCustomValue] = useState("");
  const [phase, setPhase] = useState<Phase>("compose");
  const [created, setCreated] = useState<CreatedLink | null>(null);
  const [grants, setGrants] = useState<ShareGrantSummary[] | null>(null);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const [copied, setCopied] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [listTick, setListTick] = useState(0);
  // A ready answer from the card applies only to exactly the selection it
  // was judged for; a filter still to run starts below.
  const [mediaFilter, setMediaFilter] = useState<MediaFilterState | null>(() => (
    prefill?.mediaFilter && prefill.mediaFilter !== "request" && sameShareSelection(prefill.journeyIds, listedPrefill)
      ? { status: "ready", journeyIds: listedPrefill, ...prefill.mediaFilter }
      : null
  ));
  const [mediaFilterNotice, setMediaFilterNotice] = useState<string | null>(null);
  const [mediaThumbnails, setMediaThumbnails] = useState<MediaThumbnail[]>([]);
  // Only the latest filter request
  // may land, and any change that ends the filter drops a late answer.
  const mediaSequence = useRef(0);
  // Once the owner asked to leave people out, Create stays shut until the
  // answer is final and judged for exactly the Journeys now selected.
  const mediaFilterBlocksCreate = mediaFilter !== null
    && (mediaFilter.status !== "ready" || !sameShareSelection(mediaFilter.journeyIds, selected));
  const closeBlocked = pending || revokingId !== null;
  const requestClose = useCallback(() => {
    if (closeBlocked) return false;
    return onClose();
  }, [closeBlocked, onClose]);
  const dialogRef = useModalFocus<HTMLElement>(() => {
    requestClose();
  });
  // `now` is a clock the caller may pass as an inline arrow, so its identity
  // changes every render. Reading it through a ref keeps it out of the effect
  // dependency lists below, where it would re-arm the expiry timer on every
  // render and, because that timer sets state, never settle.
  const nowRef = useRef(now);
  nowRef.current = now;

  const linkOrigin = origin ?? (typeof window === "undefined" ? "" : window.location.origin);

  const refreshShares = useCallback(async () => {
    try {
      setGrants(await mutations.listShares());
    } catch {
      // The panel is secondary to creating a link: a failed list says so in
      // its own empty state rather than replacing the creation surface with an
      // error, and it never fails silently.
      setGrants([]);
      setMessage("暂时无法读取已有的分享链接。");
    }
  }, [mutations]);

  useEffect(() => {
    void refreshShares();
  }, [refreshShares, listTick]);


  const rows: ShareLinkRow[] = useMemo(
    () => (grants ? activeShareRows(grants, nowRef.current()) : []),
    // `nowRef` is a clock, not a value, so it is deliberately not a dependency:
    // the list re-derives when the grants change, when an action ticks it, and
    // when the timer below fires at the next expiry.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [grants, listTick],
  );

  /**
   * Re-derive at the instant the nearest active grant expires.
   *
   * `deriveShareStatus` already refuses to call an expired grant active, but
   * nothing re-ran it: a panel left open past an expiry, with no create or
   * revoke in between, would go on listing a link that had already stopped
   * working. The timer is what makes the derivation happen at the moment it
   * becomes true rather than at the owner's next click.
   */
  useEffect(() => {
    if (!grants) return;
    const delay = nextShareExpiryDelay(grants, nowRef.current());
    if (delay === null) return;
    const timer = globalThis.setTimeout(() => setListTick((tick) => tick + 1), delay);
    return () => globalThis.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [grants, listTick]);

  const selectionMessage = shareSelectionMessage(selected.length);
  const maxCustom = toDateTimeLocalValue(maxCustomExpiry(now()));

  async function createLink() {
    if (pending || revokingId || mediaFilterBlocksCreate) return;
    if (selectionMessage) {
      setMessage(selectionMessage);
      return;
    }
    const expiry = resolveShareExpiry(presetId, now(), customValue);
    if (!expiry.ok) {
      setMessage(shareExpiryMessage(expiry.reason));
      return;
    }
    onMutationPendingChange?.(true);
    setPending(true);
    setMessage("");
    try {
      const mediaAssetIds = mediaFilter?.status === "ready" ? mediaFilter.assetIds : undefined;
      const response = await mutations.createShare(selected, expiry.expiresAt, mediaAssetIds);
      setCreated({
        url: shareLinkUrl(linkOrigin, response.token),
        // The server's own value, not the one just requested: #200 makes the
        // server clock the authority for what "有效至" means.
        expiresAt: response.share.expiresAt,
        journeyCount: response.share.journeyCount,
        mediaCount: mediaAssetIds ? mediaAssetIds.length : null,
      });
      setPhase("created");
      setCopied(false);
      setListTick((tick) => tick + 1);
    } catch (error) {
      setMessage(error instanceof Error && error.message
        ? error.message
        : "创建分享链接失败，请重试。");
    } finally {
      setPending(false);
      onMutationPendingChange?.(false);
    }
  }


  /**
   * End the media filter: the link goes back to sharing every media of the
   * selection. A late answer is dropped, and `notice` says why when the
   * member did not ask for this directly.
   */
  function clearMediaFilter(notice: string | null) {
    mediaSequence.current += 1;
    setMediaFilter(null);
    setMediaThumbnails([]);
    setMediaFilterNotice(notice);
  }

  // A card's "只分享风景照" arrives either judged (show its photos) or still
  // to judge (judge it here). Create stays shut until then, never widened.
  useEffect(() => {
    if (!prefill?.mediaFilter || listedPrefill.length === 0) return;
    if (prefill.mediaFilter !== "request") {
      if (mediaFilter?.status === "ready") {
        void loadMediaThumbnails(mediaSequence.current, mediaFilter.assetIds.slice(0, MAX_MEDIA_THUMBNAILS));
      } else {
        void startMediaFilter(listedPrefill);
      }
      return;
    }
    if (mutations.proposeShareMedia) void startMediaFilter(listedPrefill);
    else setMediaFilter({ status: "unavailable" });
    // Once, as the dialog opens with this prefill.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function startMediaFilter(journeyIds: string[]) {
    const proposeMedia = mutations.proposeShareMedia;
    if (!proposeMedia) return;
    const sequence = mediaSequence.current + 1;
    mediaSequence.current = sequence;
    setMediaFilter({ status: "pending", journeyIds, progress: null });
    setMediaThumbnails([]);
    setMediaFilterNotice(null);
    const isCurrent = () => sequence === mediaSequence.current;
    try {
      const result = await collectShareMediaFilter(journeyIds, proposeMedia, {
        isCurrent,
        onProgress: (progress) => {
          if (isCurrent()) setMediaFilter({ status: "pending", journeyIds, progress });
        },
      });
      if (!result || !isCurrent()) return;
      setMediaFilter({
        status: "ready",
        journeyIds,
        assetIds: result.assetIds,
        excludedCount: result.excludedCount,
      });
      void loadMediaThumbnails(sequence, result.assetIds.slice(0, MAX_MEDIA_THUMBNAILS));
    } catch (error) {
      if (sequence !== mediaSequence.current) return;
      setMediaFilter({ status: "error", journeyIds, text: shareMediaFilterErrorMessage(error) });
    }
  }

  /**
   * The owner's own authorized previews. A thumbnail that cannot be read is
   * left out of the strip; the count above it is the server's answer and
   * stays true either way.
   */
  async function loadMediaThumbnails(sequence: number, assetIds: string[]) {
    const readPreview = mutations.readShareMediaPreview;
    if (!readPreview || assetIds.length === 0) return;
    const reads = await Promise.all(assetIds.map(async (id) => {
      try {
        const read = await readPreview(id);
        return { id, url: read.preview?.url ?? read.url };
      } catch {
        return null;
      }
    }));
    if (sequence !== mediaSequence.current) return;
    setMediaThumbnails(reads.filter((read): read is MediaThumbnail => read !== null));
  }


  async function copyLink(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setMessage("");
    } catch {
      setMessage("复制失败，请手动选择链接文本。");
    }
  }

  async function nativeShare(url: string) {
    const share = navigator.share?.bind(navigator);
    if (!share) return;
    try {
      await share({ url, title: "Startrips 旅程分享" });
    } catch (error) {
      // Dismissing the sheet rejects with AbortError. That is the owner
      // choosing not to share, not a failure worth reporting.
      if (error instanceof Error && error.name === "AbortError") return;
      setMessage("系统分享未能打开，可以改用复制链接。");
    }
  }

  async function revoke(shareId: string) {
    if (revokingId || pending) return;
    onMutationPendingChange?.(true);
    setRevokingId(shareId);
    setMessage("");
    try {
      await mutations.revokeShare(shareId);
      setListTick((tick) => tick + 1);
      setMessage("链接已撤销，收到它的人无法再打开。");
    } catch {
      setMessage("撤销失败，请重试。");
    } finally {
      setRevokingId(null);
      onMutationPendingChange?.(false);
    }
  }

  const lockedJourney = lockedJourneyId
    ? journeys.find((journey) => journey.id === lockedJourneyId) ?? null
    : null;
  const canNativeShare = typeof navigator !== "undefined" && typeof navigator.share === "function";

  return (
    <div className="journey-share">
      <button
        className="journey-share__backdrop"
        type="button"
        tabIndex={-1}
        aria-label="关闭分享"
        disabled={closeBlocked}
        onClick={() => { requestClose(); }}
      />
      <section
        ref={dialogRef}
        tabIndex={-1}
        className="journey-share__dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="journey-share-title"
      >
        <header className="journey-share__heading">
          <div>
            <h2 id="journey-share-title">
              {lockedJourney ? `分享「${lockedJourney.title}」` : "分享多段旅程"}
            </h2>
          </div>
          <button type="button" disabled={closeBlocked} onClick={() => { requestClose(); }} aria-label="关闭分享">
            <IconX size={19} stroke={1.4} aria-hidden="true" />
          </button>
        </header>

        {phase === "compose" ? (
          <div className="journey-share__compose">

            {mediaFilter ? (
              <div
                className="journey-share__media-filter"
                role="status"
                data-share-media-filter={mediaFilter.status}
              >
                {mediaFilter.status === "pending" ? (
                  <p>
                    <StartripsJourneyCue state="waiting" size={28} />
                    {mediaFilter.progress
                      ? `正在挑选不含人物的照片（已检查 ${mediaFilter.progress.checked} / ${mediaFilter.progress.total}）`
                      : "正在挑选不含人物的照片，照片较多时需要一点时间…"}
                  </p>
                ) : null}
                {mediaFilter.status === "ready" ? (
                  <>
                    <p data-share-media-summary="true">
                      将分享 {mediaFilter.assetIds.length} 张风景照（已排除 {mediaFilter.excludedCount} 张含人物或无法确认的照片与视频）
                    </p>
                    {mediaThumbnails.length > 0 ? (
                      <ul className="journey-share__media-strip" aria-label="将分享的风景照">
                        {mediaThumbnails.map((thumbnail) => (
                          <li key={thumbnail.id}>
                            <img src={thumbnail.url} alt="" loading="lazy" decoding="async" />
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </>
                ) : null}
                {mediaFilter.status === "error" ? <p>{mediaFilter.text}</p> : null}
                {mediaFilter.status === "unavailable" ? (
                  <p>这台服务器不能按照片内容筛选，没有排除任何照片。如需继续，请改为分享全部照片。</p>
                ) : null}
                {mediaFilter.status !== "pending" ? (
                  <div className="journey-share__media-filter-actions">
                    {mediaFilter.status === "error" ? (
                      <button
                        type="button"
                        disabled={closeBlocked}
                        onClick={() => void startMediaFilter(mediaFilter.journeyIds)}
                      >重新挑选</button>
                    ) : null}
                    <button
                      type="button"
                      disabled={closeBlocked}
                      onClick={() => clearMediaFilter(MEDIA_FILTER_REMOVED)}
                    >改为分享全部照片</button>
                  </div>
                ) : null}
              </div>
            ) : null}
            {mediaFilterNotice ? (
              <p className="journey-share__intent-status" role="status" data-share-media-filter-notice="true">
                {mediaFilterNotice}
              </p>
            ) : null}

            {lockedJourney ? null : (
              <fieldset className="journey-share__selection">
                <legend>选择旅程</legend>
                <ol>
                  {journeys.map((journey) => {
                    const checked = selected.includes(journey.id);
                    return (
                      <li key={journey.id}>
                        <label>
                          <input
                            type="checkbox"
                            value={journey.id}
                            checked={checked}
                            onChange={() => {
                              setSelected((current) => toggleShareSelection(current, journey.id));
                              // The filtered photos described the old
                              // selection, so the link goes back to all media.
                              if (mediaFilter) clearMediaFilter(MEDIA_FILTER_CLEARED_BY_SELECTION);
                            }}
                          />
                          <span aria-hidden="true" />
                          <strong>{journey.title}</strong>
                          <small>{journey.startedOn}</small>
                        </label>
                      </li>
                    );
                  })}
                </ol>
                <p className="journey-share__selection-count" role="status">
                  已选 {selected.length} / {MAX_SHARE_JOURNEYS} 段旅程
                </p>
              </fieldset>
            )}

            <fieldset className="journey-share__expiry">
              <legend>有效期</legend>
              {SHARE_EXPIRY_PRESETS.map((preset) => (
                <label key={preset.id}>
                  <input
                    type="radio"
                    name="journey-share-expiry"
                    value={preset.id}
                    checked={presetId === preset.id}
                    onChange={() => {
                      setPresetId(preset.id);
                    }}
                  />
                  <span aria-hidden="true" />
                  {preset.label}
                </label>
              ))}
              {presetId === "custom" ? (
                <input
                  className="journey-share__custom-expiry"
                  type="datetime-local"
                  aria-label="自定义失效时间"
                  value={customValue}
                  max={maxCustom}
                  onChange={(event) => {
                    setCustomValue(event.target.value);
                  }}
                />
              ) : null}
            </fieldset>

            <p className="journey-share__notice">{SHARE_BEARER_NOTICE}</p>
            <p className="journey-share__notice">{SHARE_TOKEN_ONCE_NOTICE}</p>

            <button
              className="journey-share__create"
              type="button"
              disabled={closeBlocked || mediaFilterBlocksCreate || selected.length === 0}
              onClick={() => void createLink()}
            >
              {pending ? <StartripsJourneyCue state="waiting" size={28} /> : <IconLink size={17} stroke={1.35} aria-hidden="true" />}
              {pending ? "正在创建…" : "创建分享链接"}
            </button>
          </div>
        ) : null}

        {phase === "created" && created ? (
          <div className="journey-share__created">
            <div className="journey-share__created-heading"><StartripsJourneyCue state="arrived" size={48} /><p>同一片星空，一起看这段旅程。</p></div>
            <p className="journey-share__created-expiry">
              链接有效至 <strong data-share-expires-at={created.expiresAt}>{formatShareExpiry(created.expiresAt)}</strong>
            </p>
            <p className="journey-share__created-scope">
              包含 {created.journeyCount} 段旅程
              {created.mediaCount !== null ? `，只分享其中 ${created.mediaCount} 张风景照` : null}
            </p>
            <output className="journey-share__link" data-share-link="true">{created.url}</output>
            <p className="journey-share__notice">{SHARE_BEARER_NOTICE}</p>
            <p className="journey-share__notice">{SHARE_TOKEN_ONCE_NOTICE}</p>
            <div className="journey-share__created-actions">
              <button type="button" onClick={() => void copyLink(created.url)}>
                {copied
                  ? <IconCheck size={17} stroke={1.35} aria-hidden="true" />
                  : <IconCopy size={17} stroke={1.35} aria-hidden="true" />}
                {copied ? "已复制链接" : "复制链接"}
              </button>
              {canNativeShare ? (
                <button type="button" onClick={() => void nativeShare(created.url)}>
                  <IconShare size={17} stroke={1.35} aria-hidden="true" />
                  分享…
                </button>
              ) : null}
              <button
                type="button"
                onClick={() => {
                  // The raw token exists only here. Leaving this surface drops
                  // it rather than parking it in state the list could read.
                  setCreated(null);
                  setCopied(false);
                  setPhase("compose");
                  if (!lockedJourneyId) setSelected([]);
                  clearMediaFilter(null);
                }}
              >完成</button>
            </div>
          </div>
        ) : null}

        <section className="journey-share__links" aria-label="有效的分享链接">
          <h3>有效的分享链接</h3>
          {grants === null ? <p role="status">正在读取…</p> : null}
          {grants !== null && rows.length === 0
            ? <p className="journey-share__links-empty">目前没有有效的分享链接。</p>
            : null}
          <ol>
            {rows.map((row) => (
              <li key={row.id} data-share-row={row.id}>
                <div>
                  <strong>{row.scopeLabel}</strong>
                  <small>有效至 {row.expiryLabel}</small>
                </div>
                <button
                  type="button"
                  className="is-destructive"
                  disabled={closeBlocked}
                  onClick={() => void revoke(row.id)}
                >{revokingId === row.id ? "正在撤销…" : "撤销链接"}</button>
              </li>
            ))}
          </ol>
        </section>

        {message ? <p className="journey-share__message" role="status">{message}</p> : null}
      </section>
    </div>
  );
}
