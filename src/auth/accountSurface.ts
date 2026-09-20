export type AccountSurface =
  | "menu"
  | "invite"
  | "edit"
  | "password-change"
  | "password-enroll"
  | null;

const DRILL_SURFACES: readonly AccountSurface[] = [
  "invite",
  "edit",
  "password-change",
  "password-enroll",
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

export function accountSurfaceEyebrow(surface: AccountSurface): string {
  switch (surface) {
    case "invite":
      return "INVITATION";
    case "password-change":
    case "password-enroll":
      return "ACCOUNT SECURITY";
    default:
      return "ATLAS DETAILS";
  }
}

export function accountSurfaceTitle(surface: AccountSurface): string {
  switch (surface) {
    case "invite":
      return "邀请另一位";
    case "password-change":
      return "修改密码";
    case "password-enroll":
      return "设置密码";
    default:
      return "编辑图谱";
  }
}

export function shouldRenderStandaloneAccountDock(isMobileV2: boolean, hasMobileAccountHost: boolean): boolean {
  return !isMobileV2 || !hasMobileAccountHost;
}
export function shouldActivateAccountSheetFocus(accountSheetOpen: boolean, atlasReady: boolean): boolean {
  return accountSheetOpen && atlasReady;
}
