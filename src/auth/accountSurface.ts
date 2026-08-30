export type AccountSurface = "menu" | "invite" | "edit" | null;

export function previousAccountSurface(surface: AccountSurface): AccountSurface {
  return surface === "invite" || surface === "edit" ? "menu" : null;
}

export function shouldRenderStandaloneAccountDock(isMobileV2: boolean, hasMobileAccountHost: boolean): boolean {
  return !isMobileV2 || !hasMobileAccountHost;
}
export function shouldActivateAccountSheetFocus(accountSheetOpen: boolean, atlasReady: boolean): boolean {
  return accountSheetOpen && atlasReady;
}
