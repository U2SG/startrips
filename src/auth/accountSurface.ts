/**
 * #346 (ST-124): the account menu's surfaces.
 *
 * The password entry is two different flows, and the owner's 2026-09-21
 * decision on #346 settled which one a credential-less Account gets: not an
 * inline enrollment form, but a set-password link sent to the Account's own
 * verified address — the same delivery the sign-in gate's forgot-password mode
 * already uses. That request has outcomes the person must be able to read
 * (sent, link expired at redemption, delivery refused), so those outcomes are
 * surfaces here rather than a second state machine living inside a component.
 */
export type AccountSurface =
  | "menu"
  | "invite"
  | "edit"
  | "password-change"
  | "password-link-offered"
  | "password-link-sent"
  | "password-link-expired"
  | "password-link-failed"
  | null;

const PASSWORD_LINK_SURFACES: readonly AccountSurface[] = [
  "password-link-offered",
  "password-link-sent",
  "password-link-expired",
  "password-link-failed",
];

const DRILL_SURFACES: readonly AccountSurface[] = [
  "invite",
  "edit",
  "password-change",
  ...PASSWORD_LINK_SURFACES,
];

export function previousAccountSurface(surface: AccountSurface): AccountSurface {
  return DRILL_SURFACES.includes(surface) ? "menu" : null;
}

/**
 * True for every surface that drills one level below the account menu.
 *
 * The mobile back stack and the sheet header both key on this rather than on a
 * hand-written list of surface names, so a surface added to the union cannot
 * silently inherit another surface's title or skip its own history entry.
 */
export function isAccountFormSurface(surface: AccountSurface): boolean {
  return DRILL_SURFACES.includes(surface);
}

export function isPasswordLinkSurface(surface: AccountSurface): boolean {
  return PASSWORD_LINK_SURFACES.includes(surface);
}

export function isAccountPasswordSurface(surface: AccountSurface): boolean {
  return surface === "password-change" || isPasswordLinkSurface(surface);
}

/**
 * What the set-password link flow can report back.
 *
 * `expired` is deliberately not something the request itself can answer: the
 * server owns the link's single-use lifetime and only says so at redemption,
 * so that outcome arrives from the reset page handing the person back here.
 * `resend` is the person asking again after any terminal state.
 */
export type PasswordLinkOutcome = "sent" | "expired" | "failed" | "resend";

/**
 * The link flow's only transition. A surface outside the flow is returned
 * untouched, so an outcome that arrives late — a resolved request for a panel
 * the person already navigated away from — cannot drag another surface into
 * the password flow.
 */
export function nextPasswordLinkSurface(
  surface: AccountSurface,
  outcome: PasswordLinkOutcome,
): AccountSurface {
  if (!isPasswordLinkSurface(surface)) return surface;
  switch (outcome) {
    case "sent":
      return "password-link-sent";
    case "expired":
      return "password-link-expired";
    case "failed":
      return "password-link-failed";
    case "resend":
      return "password-link-offered";
  }
}

/**
 * An expired link is discovered on `/reset-password`, a different document
 * from the account surface that sent it. The redemption page hands the person
 * back with this non-secret marker — never the token — so the surface can open
 * on the expired state and offer to send another one.
 */
export const EXPIRED_PASSWORD_LINK_QUERY = "accountPassword=link-expired";

export function accountSurfaceFromLocationSearch(search: string): AccountSurface {
  const value = new URLSearchParams(search).get("accountPassword");
  return value === "link-expired" ? "password-link-expired" : null;
}

export function accountSurfaceEyebrow(surface: AccountSurface): string {
  if (isAccountPasswordSurface(surface)) return "ACCOUNT SECURITY";
  return surface === "invite" ? "INVITATION" : "ATLAS DETAILS";
}

export function accountSurfaceTitle(surface: AccountSurface): string {
  if (surface === "password-change") return "修改密码";
  if (isPasswordLinkSurface(surface)) return "设置密码";
  return surface === "invite" ? "邀请另一位" : "编辑图谱";
}

/**
 * The sentence each link-flow state says. One mapping serves both the account
 * panel and the reset page, so an expired link cannot be described one way
 * where it is redeemed and another way where it is resent.
 */
export function passwordLinkSurfaceText(surface: AccountSurface): string {
  switch (surface) {
    case "password-link-offered":
      return "这个账户还没有登录密码。我们会把设置密码的链接发送到已验证的账户邮箱。";
    case "password-link-sent":
      return "设置密码的链接已经发送到账户邮箱，请在链接过期前打开它。";
    case "password-link-expired":
      return "这个设置链接已经失效，请重新发送一封。";
    case "password-link-failed":
      return "设置链接没有发送成功，请稍后再试。";
    default:
      return "";
  }
}

export function shouldRenderStandaloneAccountDock(isMobileV2: boolean, hasMobileAccountHost: boolean): boolean {
  return !isMobileV2 || !hasMobileAccountHost;
}
export function shouldActivateAccountSheetFocus(accountSheetOpen: boolean, atlasReady: boolean): boolean {
  return accountSheetOpen && atlasReady;
}
