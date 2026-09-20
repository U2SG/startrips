import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { previousAccountSurface, shouldActivateAccountSheetFocus, shouldRenderStandaloneAccountDock } from "./accountSurface";

describe("mobile account surface", () => {
  it("unwinds a nested form before closing the account sheet", () => {
    expect(previousAccountSurface("invite")).toBe("menu");
    expect(previousAccountSurface("edit")).toBe("menu");
    expect(previousAccountSurface("menu")).toBeNull();
  });


  it("restarts mobile sheet focus ownership across an Atlas reload", () => {
    expect(shouldActivateAccountSheetFocus(true, true)).toBe(true);
    expect(shouldActivateAccountSheetFocus(true, false)).toBe(false);
    expect(shouldActivateAccountSheetFocus(false, true)).toBe(false);
  });

  it("keeps the standalone account dock until the mobile Atlas slot mounts", () => {
    expect(shouldRenderStandaloneAccountDock(false, false)).toBe(true);
    expect(shouldRenderStandaloneAccountDock(false, true)).toBe(true);
    expect(shouldRenderStandaloneAccountDock(true, false)).toBe(true);
    expect(shouldRenderStandaloneAccountDock(true, true)).toBe(false);
  });

  it("never offers a current-password field to a credential-less Account", () => {
    const auth = readFileSync("src/auth/AuthGateway.tsx", "utf8");
    const panel = auth.slice(
      auth.indexOf("function AccountPasswordPanel"),
      auth.indexOf("function WorkspaceGate"),
    );
    expect(panel).not.toBe("");
    // The credential-less branch returns before the change form is reachable,
    // so the only "current password" input belongs to the change surface.
    const credentialLess = panel.indexOf('state.kind !== "change"');
    const currentPasswordField = panel.indexOf('name="currentPassword"');
    expect(credentialLess).toBeGreaterThan(-1);
    expect(currentPasswordField).toBeGreaterThan(credentialLess);
    expect(panel.split('name="currentPassword"')).toHaveLength(2);
  });

  it("holds no password, grant or token in account-panel component state", () => {
    const auth = readFileSync("src/auth/AuthGateway.tsx", "utf8");
    const panel = auth.slice(
      auth.indexOf("function AccountPasswordPanel"),
      auth.indexOf("function WorkspaceGate"),
    );
    for (const state of panel.match(/useState[^\n]*/g) ?? []) {
      expect(state).not.toMatch(/password|token|grant|reverif/i);
    }
    // Uncontrolled inputs: a controlled one would put the secret in state.
    for (const field of panel.match(/<input[^>]*type="password"[^>]*>/g) ?? []) {
      expect(field).not.toContain("value={");
    }
    expect(panel).toContain("form.reset()");
  });

  it("re-reads the live session after a successful password write", () => {
    const auth = readFileSync("src/auth/AuthGateway.tsx", "utf8");
    expect(auth).toContain("refreshSession: () => authClient.getSession()");
    // The server revokes other sessions on a change and says how many; the
    // panel reports that outcome rather than asserting a fixed one.
    expect(auth).toContain("result.revokedOtherSessions > 0");
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
