export type AccountSurface = "menu" | "invite" | "edit" | null;

export function previousAccountSurface(surface: AccountSurface): AccountSurface {
  return surface === "invite" || surface === "edit" ? "menu" : null;
}
