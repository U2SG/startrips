import { SHARE_VIEW_PATHNAME } from "./sharedAtlas";
import type { ShareGrantStatus, ShareGrantSummary } from "./types";

/**
 * #200 phase E: the owner-facing share surface, as pure rules.
 *
 * Everything here is the part of the share UI that can be wrong without a
 * browser noticing: which instant a preset resolves to, which link text is
 * copied, whether a row still counts as active, and what a row is allowed to
 * carry. The React surface reads these; it decides no share semantics itself.
 */

/**
 * The server's own ceiling, from `MAX_SHARE_LIFETIME_MS` in
 * `server/authorization/share-access.ts`. Mirrored rather than fetched because
 * a custom expiry has to be refused *before* the request: `parseShareInput`
 * answers a single opaque `INVALID_SHARE` for every unusable body, so a client
 * that let an over-long date through could only tell the owner "invalid",
 * never which of the two bounds they crossed.
 */
export const MAX_SHARE_LIFETIME_MS = 365 * 24 * 60 * 60 * 1000;

/** A share must outlive the request that creates it by at least this much. */
export const MIN_SHARE_LIFETIME_MS = 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

export type ShareExpiryPresetId = "1d" | "7d" | "30d" | "custom";

export type ShareExpiryPreset = {
  id: ShareExpiryPresetId;
  label: string;
  days: number | null;
};

/**
 * V1 presets from #200. There is deliberately no permanent-link entry: the
 * issue forbids silently creating one, and a missing option cannot be chosen
 * by accident.
 */
export const SHARE_EXPIRY_PRESETS: readonly ShareExpiryPreset[] = [
  { id: "1d", label: "1 天", days: 1 },
  { id: "7d", label: "7 天", days: 7 },
  { id: "30d", label: "30 天", days: 30 },
  { id: "custom", label: "自定义", days: null },
];

export type ShareExpiryFailure = "custom-missing" | "custom-invalid" | "too-soon" | "too-far";

export type ShareExpiryResolution =
  | { ok: true; expiresAt: Date }
  | { ok: false; reason: ShareExpiryFailure };

/**
 * The instant a chosen expiry means, as an absolute Date the request can
 * carry.
 *
 * A preset is measured from `now`, so the value sent is always a fresh offset
 * rather than one computed when the sheet opened. A custom value arrives as
 * the `datetime-local` string the input produces, which has no zone: it is
 * read in the browser's own zone, which is the zone the owner typed it in.
 * The server re-validates all of this; failing here first is what lets the
 * owner see which bound they crossed.
 */
export function resolveShareExpiry(
  presetId: ShareExpiryPresetId,
  now: Date,
  customValue = "",
): ShareExpiryResolution {
  const preset = SHARE_EXPIRY_PRESETS.find((entry) => entry.id === presetId);
  if (!preset) return { ok: false, reason: "custom-invalid" };

  let expiresAt: Date;
  if (preset.days !== null) {
    expiresAt = new Date(now.valueOf() + preset.days * DAY_MS);
  } else {
    const trimmed = customValue.trim();
    if (!trimmed) return { ok: false, reason: "custom-missing" };
    expiresAt = new Date(trimmed);
    if (Number.isNaN(expiresAt.valueOf())) return { ok: false, reason: "custom-invalid" };
  }

  const lifetime = expiresAt.valueOf() - now.valueOf();
  if (lifetime < MIN_SHARE_LIFETIME_MS) return { ok: false, reason: "too-soon" };
  if (lifetime > MAX_SHARE_LIFETIME_MS) return { ok: false, reason: "too-far" };
  return { ok: true, expiresAt };
}

export function shareExpiryMessage(reason: ShareExpiryFailure): string {
  switch (reason) {
    case "custom-missing":
      return "请选择链接失效的时间。";
    case "custom-invalid":
      return "这个时间无法识别，请重新选择。";
    case "too-soon":
      return "失效时间至少要比现在晚一分钟。";
    case "too-far":
      return "失效时间最长为一年。";
  }
}

/** The largest custom value the picker offers, so the bound is visible. */
export function maxCustomExpiry(now: Date): Date {
  return new Date(now.valueOf() + MAX_SHARE_LIFETIME_MS);
}

/**
 * `datetime-local` reads and writes local wall-clock text with no zone, so the
 * value has to be built from the local getters rather than `toISOString()`,
 * which would shift the displayed time by the owner's offset.
 */
export function toDateTimeLocalValue(value: Date): string {
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`
    + `T${pad(value.getHours())}:${pad(value.getMinutes())}`;
}

/**
 * The exact expiration instant, shown to the owner in their own zone.
 *
 * #200 requires the owner to see the exact expiration, and the value formatted
 * here is always the server's `expiresAt` from the response — never the client
 * value that was requested — because the server clock is the authority.
 */
export function formatShareExpiry(expiresAt: string | Date): string {
  const value = expiresAt instanceof Date ? expiresAt : new Date(expiresAt);
  if (Number.isNaN(value.valueOf())) return "";
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`
    + ` ${pad(value.getHours())}:${pad(value.getMinutes())}`;
}

/**
 * The link a recipient opens.
 *
 * The token goes in the fragment, per the #200 design amendment: a fragment is
 * never transmitted to any server, so it cannot reach an access log, a
 * `Referer` header or a link-preview bot. `SHARE_VIEW_PATHNAME` is imported
 * rather than repeated so the owner's copy and the guest's parser can never
 * describe different paths.
 */
export function shareLinkUrl(origin: string, token: string): string {
  return `${origin.replace(/\/+$/, "")}${SHARE_VIEW_PATHNAME}#${token}`;
}

/**
 * What one row of the share list may say.
 *
 * There is no token field, and that is the point rather than an omission:
 * #200 stores only a hash, so a raw token exists exactly once, in the create
 * response. A row model that cannot carry one cannot grow a copy-again
 * affordance that would silently need the storage weakened to work.
 */
export type ShareLinkRow = {
  id: string;
  scopeLabel: string;
  journeyCount: number;
  expiryLabel: string;
  createdAt: string;
  status: ShareGrantStatus;
  statusLabel: string;
  active: boolean;
};

/** Two titles read as a list; more than that reads as a count. */
export function shareScopeLabel(
  journeys: readonly { title: string }[],
  journeyCount: number,
): string {
  const titles = journeys.map((journey) => journey.title).filter((title) => title.length > 0);
  if (titles.length === 0) return `${journeyCount} 段旅程`;
  if (titles.length <= 2) return titles.join(" · ");
  return `${titles.slice(0, 2).join(" · ")} 等 ${journeyCount} 段旅程`;
}

export function shareStatusLabel(status: ShareGrantStatus): string {
  switch (status) {
    case "active":
      return "有效";
    case "revoked":
      return "已撤销";
    case "expired":
      return "已过期";
    default:
      return "不可用";
  }
}

/**
 * The status the owner is shown.
 *
 * `GET /api/shares` evaluates status once, when the request is served, so a
 * panel left open would go on calling a grant active for as long as it stayed
 * open. The server's answer is the floor — it is the only party that can say
 * `revoked` or `atlas-unavailable` — and the local clock may only take a grant
 * out of `active` as its own expiry passes, never back into it.
 */
export function deriveShareStatus(
  grant: { status: ShareGrantStatus; expiresAt: string },
  now: Date,
): ShareGrantStatus {
  if (grant.status !== "active") return grant.status;
  const expiresAt = new Date(grant.expiresAt);
  if (Number.isNaN(expiresAt.valueOf())) return grant.status;
  return expiresAt.valueOf() <= now.valueOf() ? "expired" : "active";
}

export function shareLinkRow(grant: ShareGrantSummary, now: Date): ShareLinkRow {
  const status = deriveShareStatus(grant, now);
  return {
    id: grant.id,
    scopeLabel: shareScopeLabel(grant.journeys, grant.journeyCount),
    journeyCount: grant.journeyCount,
    expiryLabel: formatShareExpiry(grant.expiresAt),
    createdAt: grant.createdAt,
    status,
    statusLabel: shareStatusLabel(status),
    active: status === "active",
  };
}

/**
 * The rows the management panel lists, newest first.
 *
 * #200 asks for a list of active links that a revoked link leaves. Expired and
 * revoked grants are dropped here rather than rendered greyed out, so the
 * panel answers exactly one question — what is still reachable right now —
 * and revoking is visibly the thing that removes a link from it.
 */
export function activeShareRows(
  grants: readonly ShareGrantSummary[],
  now: Date,
): ShareLinkRow[] {
  return grants
    .map((grant) => shareLinkRow(grant, now))
    .filter((row) => row.active)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

/**
 * The server's own per-grant ceiling, mirrored so an over-large selection is
 * refused with a sentence rather than an opaque `INVALID_SHARE`.
 */
export const MAX_SHARE_JOURNEYS = 64;

/** Whether the current selection can become a link. */
export function shareSelectionMessage(selectedCount: number): string | null {
  if (selectedCount < 1) return "请至少选择一段旅程。";
  if (selectedCount > MAX_SHARE_JOURNEYS) return `一个链接最多包含 ${MAX_SHARE_JOURNEYS} 段旅程。`;
  return null;
}

/**
 * Selection is a set operation on Journey ids and nothing else.
 *
 * #200 forbids reusing the media multi-select state for this, so sharing keeps
 * its own toggle rather than borrowing one whose entries mean "asset".
 */
export function toggleShareSelection(
  selected: readonly string[],
  journeyId: string,
): string[] {
  return selected.includes(journeyId)
    ? selected.filter((id) => id !== journeyId)
    : [...selected, journeyId];
}

/**
 * The sentence the owner must read before a link exists.
 *
 * Kept verbatim from the #200 design amendment: a bearer link means exactly
 * this, and the issue calls it the product definition rather than a defect to
 * engineer around.
 */
export const SHARE_BEARER_NOTICE = "任何获得此链接的人都可以在有效期内查看所选旅程，但不能编辑。";

/** Why the raw link cannot be produced again from the management list. */
export const SHARE_TOKEN_ONCE_NOTICE = "链接只在创建时显示一次，之后无法再次复制；需要新链接请重新创建。";

/**
 * The largest delay `setTimeout` can hold before it is clamped and fires
 * immediately. A share may be up to a year out, which is well past it.
 */
export const MAX_TIMEOUT_DELAY_MS = 2_147_483_647;

/**
 * How long until the nearest still-active grant expires, or `null` when
 * nothing is going to change on its own.
 *
 * `deriveShareStatus` refuses to call an expired grant active, but something
 * has to re-run it: a panel left open past an expiry, with no create or revoke
 * in between, would otherwise go on listing a link that had already stopped
 * working. The returned delay is what schedules that re-derivation for the
 * instant it becomes true rather than the owner's next click, and it is capped
 * so a far-future expiry re-arms instead of firing at once.
 */
export function nextShareExpiryDelay(
  grants: readonly ShareGrantSummary[],
  now: Date,
): number | null {
  const current = now.valueOf();
  const soonest = grants
    .filter((grant) => grant.status === "active")
    .map((grant) => new Date(grant.expiresAt).valueOf())
    .filter((value) => Number.isFinite(value) && value > current)
    .sort((left, right) => left - right)[0];
  if (soonest === undefined) return null;
  return Math.min(soonest - current + 1_000, MAX_TIMEOUT_DELAY_MS);
}
