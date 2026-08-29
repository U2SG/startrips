import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { previousAccountSurface, shouldRenderStandaloneAccountDock } from "./accountSurface";

describe("mobile account surface", () => {
  it("unwinds a nested form before closing the account sheet", () => {
    expect(previousAccountSurface("invite")).toBe("menu");
    expect(previousAccountSurface("edit")).toBe("menu");
    expect(previousAccountSurface("menu")).toBeNull();
  });


  it("keeps the standalone account dock until the mobile Atlas slot mounts", () => {
    expect(shouldRenderStandaloneAccountDock(false, false)).toBe(true);
    expect(shouldRenderStandaloneAccountDock(false, true)).toBe(true);
    expect(shouldRenderStandaloneAccountDock(true, false)).toBe(true);
    expect(shouldRenderStandaloneAccountDock(true, true)).toBe(false);
  });

  it("restores pointer events on the mobile account sheet layer", () => {
    const authCss = readFileSync("src/styles/auth-gate.css", "utf8");
    expect(authCss).toMatch(/\.account-sheet-layer\s*\{[^}]*pointer-events:\s*auto;/s);
  });

  it("uses the Atlas header slot instead of independently positioning the mobile trigger", () => {
    const app = readFileSync("src/journey/LivingAtlasApp.tsx", "utf8");
    const auth = readFileSync("src/auth/AuthGateway.tsx", "utf8");
    const atlasCss = readFileSync("src/styles/living-atlas.css", "utf8");
    const authCss = readFileSync("src/styles/auth-gate.css", "utf8");

    const accountSlot = app.indexOf("<MobileAccountActionSlot />");
    const createAction = app.indexOf("onClick={openCreateComposer}", accountSlot);
    expect(accountSlot).toBeGreaterThan(-1);
    expect(createAction).toBeGreaterThan(accountSlot);
    expect(auth).toContain("createPortal(");
    expect(auth).toContain('"account-sheet"');
    expect(auth).toContain('"account-form"');
    expect(atlasCss).not.toContain("Reserve room for .account-dock");
    expect(authCss).not.toContain("top:66px");
    expect(authCss).not.toMatch(/@media[^}]+\.account-dock\s*\{/s);
  });
});
