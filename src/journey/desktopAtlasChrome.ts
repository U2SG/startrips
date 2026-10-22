/**
 * Desktop Atlas chrome rules: which right-edge surface owns the screen, and
 * which Atlas actions live behind the header's 更多 menu.
 *
 * Desktop has one right-hand column. The current-journey card, the Route Point
 * context, the Home Base context and the Atlas Everyday panel all anchor to it,
 * so at most one of them may be visible at a time. The existing open/close
 * paths already make the three context surfaces replace each other; the
 * resolver is the single place that decides what shows, and the current-journey
 * card is only the resting state the column returns to when no context is open.
 */
export type DesktopRightSurface = "route-point" | "home-base" | "everyday" | "journey" | null;

export function resolveDesktopRightSurface({
  routePoint,
  homeBase,
  everyday,
  journey,
}: {
  /** The Route Point context is open for the current Journey. */
  routePoint: boolean;
  /** A confirmed Home Base period context is open. */
  homeBase: boolean;
  /** The Atlas-level Everyday panel is open. */
  everyday: boolean;
  /** The planet view has a current Journey whose card can rest in the column. */
  journey: boolean;
}): DesktopRightSurface {
  // A globe selection is the most specific intent, then a Home Base marker,
  // then the Atlas-wide Everyday list. Opening any of them already closes the
  // others, so this order only settles a transient overlap inside one commit.
  if (routePoint) return "route-point";
  if (homeBase) return "home-base";
  if (everyday) return "everyday";
  return journey ? "journey" : null;
}

export type DesktopMoreAction = "import" | "everyday" | "globe-focus";

/**
 * The desktop header keeps the view switch, 记录旅程 and 分享 visible. Every
 * other Atlas action sits in one 更多 menu, each under the same condition its
 * header button had. Import has exactly this one desktop header entry.
 */
export function desktopHeaderMoreActions({
  canImport,
  everydayAvailable,
}: {
  canImport: boolean;
  everydayAvailable: boolean;
}): DesktopMoreAction[] {
  const actions: DesktopMoreAction[] = [];
  if (canImport) actions.push("import");
  if (everydayAvailable) actions.push("everyday");
  // 只看地球 was always offered by the desktop header.
  actions.push("globe-focus");
  return actions;
}

/** A short menu stays one column; past four items it splits into two. */
export function desktopMoreMenuColumns(actionCount: number): 1 | 2 {
  return actionCount > 4 ? 2 : 1;
}
