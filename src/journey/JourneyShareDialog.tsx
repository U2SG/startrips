import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  formatShareExpiry,
  maxCustomExpiry,
  nextShareExpiryDelay,
  resolveShareExpiry,
  shareExpiryMessage,
  shareLinkUrl,
  shareSelectionMessage,
  toDateTimeLocalValue,
  toggleShareSelection,
  type ShareExpiryPresetId,
  type ShareLinkRow,
} from "./shareLinks";
import { useModalFocus } from "./useModalFocus";
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
  mutations: Pick<AtlasMutations, "createShare" | "listShares" | "revokeShare">;
  onClose: () => void;
  /** Injected by the tests; the browser passes nothing. */
  now?: () => Date;
  origin?: string;
};

type CreatedLink = {
  url: string;
  expiresAt: string;
  journeyCount: number;
};

type Phase = "compose" | "created";

export function JourneyShareDialog({
  journeys,
  lockedJourneyId,
  mutations,
  onClose,
  now = () => new Date(),
  origin,
}: JourneyShareDialogProps) {
  const dialogRef = useModalFocus<HTMLElement>(onClose);
  const [selected, setSelected] = useState<string[]>(
    lockedJourneyId ? [lockedJourneyId] : [],
  );
  const [presetId, setPresetId] = useState<ShareExpiryPresetId>("7d");
  const [customValue, setCustomValue] = useState("");
  const [phase, setPhase] = useState<Phase>("compose");
  const [created, setCreated] = useState<CreatedLink | null>(null);
  const [grants, setGrants] = useState<ShareGrantSummary[] | null>(null);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const [copied, setCopied] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [listTick, setListTick] = useState(0);
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
    if (pending) return;
    if (selectionMessage) {
      setMessage(selectionMessage);
      return;
    }
    const expiry = resolveShareExpiry(presetId, now(), customValue);
    if (!expiry.ok) {
      setMessage(shareExpiryMessage(expiry.reason));
      return;
    }
    setPending(true);
    setMessage("");
    try {
      const response = await mutations.createShare(selected, expiry.expiresAt);
      setCreated({
        url: shareLinkUrl(linkOrigin, response.token),
        // The server's own value, not the one just requested: #200 makes the
        // server clock the authority for what "有效至" means.
        expiresAt: response.share.expiresAt,
        journeyCount: response.share.journeyCount,
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
    }
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
    if (revokingId) return;
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
        onClick={onClose}
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
            <p>SHARE JOURNEYS</p>
            <h2 id="journey-share-title">
              {lockedJourney ? `分享「${lockedJourney.title}」` : "分享多段旅程"}
            </h2>
          </div>
          <button type="button" onClick={onClose} aria-label="关闭分享">
            <IconX size={19} stroke={1.4} aria-hidden="true" />
          </button>
        </header>

        {phase === "compose" ? (
          <div className="journey-share__compose">
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
                            checked={checked}
                            onChange={() => setSelected((current) => toggleShareSelection(current, journey.id))}
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
                    onChange={() => setPresetId(preset.id)}
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
                  onChange={(event) => setCustomValue(event.target.value)}
                />
              ) : null}
            </fieldset>

            <p className="journey-share__notice">{SHARE_BEARER_NOTICE}</p>
            <p className="journey-share__notice">{SHARE_TOKEN_ONCE_NOTICE}</p>

            <button
              className="journey-share__create"
              type="button"
              disabled={pending || selected.length === 0}
              onClick={() => void createLink()}
            >
              <IconLink size={17} stroke={1.35} aria-hidden="true" />
              {pending ? "正在创建…" : "创建分享链接"}
            </button>
          </div>
        ) : null}

        {phase === "created" && created ? (
          <div className="journey-share__created">
            <p className="journey-share__created-expiry">
              链接有效至 <strong data-share-expires-at={created.expiresAt}>{formatShareExpiry(created.expiresAt)}</strong>
            </p>
            <p className="journey-share__created-scope">
              包含 {created.journeyCount} 段旅程
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
                  disabled={revokingId !== null}
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
