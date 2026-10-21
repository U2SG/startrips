import { describe, expect, it } from "vitest";
import {
  desktopHeaderMoreActions,
  desktopMoreMenuColumns,
  resolveDesktopRightSurface,
} from "./desktopAtlasChrome";

describe("desktop right surface", () => {
  const none = { routePoint: false, homeBase: false, everyday: false, journey: false };

  it("rests on the current-journey card when no context surface is open", () => {
    expect(resolveDesktopRightSurface({ ...none, journey: true })).toBe("journey");
    expect(resolveDesktopRightSurface(none)).toBeNull();
  });

  it("gives the column to exactly one context surface and hides the card", () => {
    expect(resolveDesktopRightSurface({ ...none, journey: true, routePoint: true })).toBe("route-point");
    expect(resolveDesktopRightSurface({ ...none, journey: true, homeBase: true })).toBe("home-base");
    expect(resolveDesktopRightSurface({ ...none, journey: true, everyday: true })).toBe("everyday");
    // A context surface does not need a current Journey to own the column.
    expect(resolveDesktopRightSurface({ ...none, everyday: true })).toBe("everyday");
  });

  it("settles a transient overlap on the most specific intent", () => {
    const all = { routePoint: true, homeBase: true, everyday: true, journey: true };
    expect(resolveDesktopRightSurface(all)).toBe("route-point");
    expect(resolveDesktopRightSurface({ ...all, routePoint: false })).toBe("home-base");
    expect(resolveDesktopRightSurface({ ...all, routePoint: false, homeBase: false })).toBe("everyday");
  });

  it("returns to the card once the open context closes", () => {
    const open = { ...none, journey: true, everyday: true };
    expect(resolveDesktopRightSurface(open)).toBe("everyday");
    expect(resolveDesktopRightSurface({ ...open, everyday: false })).toBe("journey");
  });
});

describe("desktop header 更多 menu", () => {
  it("holds import, Everyday and globe focus in a stable order", () => {
    expect(desktopHeaderMoreActions({ canImport: true, everydayAvailable: true }))
      .toEqual(["import", "everyday", "globe-focus"]);
  });

  it("keeps each action under the condition its header button had", () => {
    expect(desktopHeaderMoreActions({ canImport: false, everydayAvailable: true }))
      .toEqual(["everyday", "globe-focus"]);
    expect(desktopHeaderMoreActions({ canImport: true, everydayAvailable: false }))
      .toEqual(["import", "globe-focus"]);
    expect(desktopHeaderMoreActions({ canImport: false, everydayAvailable: false }))
      .toEqual(["globe-focus"]);
  });

  it("offers import exactly once", () => {
    const actions = desktopHeaderMoreActions({ canImport: true, everydayAvailable: true });
    expect(actions.filter((action) => action === "import")).toHaveLength(1);
  });

  it("splits into two columns only past four items", () => {
    expect(desktopMoreMenuColumns(1)).toBe(1);
    expect(desktopMoreMenuColumns(4)).toBe(1);
    expect(desktopMoreMenuColumns(5)).toBe(2);
  });
});
