import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { previousAccountSurface, shouldActivateAccountSheetFocus, shouldOpenDockForRevealedPanel, shouldRenderStandaloneAccountDock } from "./accountSurface";

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
    // Both credential-less branches return before the change form is
    // reachable, so the only "current password" input belongs to the change
    // surface — and no branch renders a new-password field for them either.
    const sendLink = panel.indexOf('state.kind === "send-link"');
    const recover = panel.indexOf('state.kind === "recover"');
    const currentPasswordField = panel.indexOf('name="currentPassword"');
    expect(sendLink).toBeGreaterThan(-1);
    expect(recover).toBeGreaterThan(sendLink);
    expect(currentPasswordField).toBeGreaterThan(recover);
    expect(panel.split('name="currentPassword"')).toHaveLength(2);
    expect(panel.split('type="password"')).toHaveLength(3);
  });

  it("gives a credential-less Account the link delivery, not the enrollment route", () => {
    const auth = readFileSync("src/auth/AuthGateway.tsx", "utf8");
    // #346 option B: the account surface never posts to a route whose grant a
    // passwordless Account cannot obtain, so those paths appear nowhere here.
    expect(auth).not.toContain("password/enrollment");
    expect(auth).not.toContain("reverify/password");
    expect(auth).toContain("requestSetPasswordLink");
    expect(auth).toContain("authClient.requestPasswordReset(input)");
    // Each link outcome is read from the shared surface vocabulary rather than
    // from an ad-hoc sentence in this component.
    expect(auth).toContain("passwordLinkSurfaceText(surface)");
    expect(auth).toContain("nextPasswordLinkSurface(surface, result.outcome)");
  });

  it("hands an expired link back to the surface that can resend it, without the token", () => {
    const auth = readFileSync("src/auth/AuthGateway.tsx", "utf8");
    const resetPage = auth.slice(
      auth.indexOf("function ResetPassword"),
      auth.indexOf("function InvitationGate"),
    );
    expect(resetPage).toContain('passwordLinkSurfaceText("password-link-expired")');
    expect(resetPage).toContain("href={`/?${EXPIRED_PASSWORD_LINK_QUERY}`}");
    expect(resetPage).not.toContain("token=${");
    // The invitation wording that used to answer a failed password redemption
    // is gone; an expired set-password link now says so in its own words.
    expect(resetPage).not.toContain("邀请已失效");
    expect(auth).toContain('openAccountPassword("password-link-expired")');
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
    const panel = auth.slice(
      auth.indexOf("function AccountPasswordPanel"),
      auth.indexOf("function WorkspaceGate"),
    );
    const success = panel.slice(
      panel.indexOf("result.revokedOtherSessions > 0"),
      panel.indexOf("} catch (error)"),
    );
    expect(success).not.toBe("");
    // server/account-identities/password-change.ts deletes every session for
    // this user EXCEPT the calling one and returns how many it deleted, so the
    // panel refreshes the surviving session and reports the server's count
    // both ways instead of claiming a fixed outcome.
    expect(panel).toContain("refreshSession: () => authClient.getSession()");
    expect(success).toContain("其他 ${result.revokedOtherSessions} 处登录已退出");
    expect(success).toContain("当前登录继续有效");
    // The calling session stays valid: nothing here signs the person out, and
    // the client never asks the server to revoke — that decision is the
    // route's, and a replayed grant reports alreadyChanged with zero revoked.
    expect(panel).not.toContain("signOut");
    expect(panel).not.toContain("revokeOtherSessions:");
  });

  it("keeps the desktop dock showing one account panel at a time", () => {
    const auth = readFileSync("src/auth/AuthGateway.tsx", "utf8");
    const actions = auth.slice(
      auth.indexOf('<div className="account-dock__actions">'),
      auth.indexOf("<EarthExperienceMenuEntry"),
    );
    expect(actions).not.toBe("");
    const entry = (label: string) => actions.split("\n").find((line) => line.includes(label)) ?? "";
    // Each dock entry closes the other two, so the password panel cannot
    // render beside the invitation or the Atlas edit form.
    expect(entry("邀请另一位")).toContain("setPasswordOpen(false)");
    expect(entry("邀请另一位")).toContain("setEditAtlasOpen(false)");
    expect(entry("编辑图谱")).toContain("setPasswordOpen(false)");
    expect(entry("编辑图谱")).toContain("setInviteOpen(false)");
    expect(entry("邀请另一位")).toContain("setIdentityOpen(false)");
    expect(entry("编辑图谱")).toContain("setIdentityOpen(false)");
    // The sign-in-methods entry clears the other three the same way.
    expect(entry("登录方式")).toContain("setInviteOpen(false)");
    expect(entry("登录方式")).toContain("setEditAtlasOpen(false)");
    expect(entry("登录方式")).toContain("setPasswordOpen(false)");
    // The password entry clears the others through its own opener, which also
    // drops the previous read's surface so a stale "link sent" cannot reopen.
    const openerStart = auth.indexOf("const openAccountPassword");
    const openerEnd = auth.indexOf("await Promise.all", openerStart);
    expect(openerStart).toBeGreaterThan(-1);
    expect(openerEnd).toBeGreaterThan(openerStart);
    const opener = auth.slice(openerStart, openerEnd);
    expect(opener.length).toBeLessThan(1200);
    expect(opener).toContain("setInviteOpen(false)");
    expect(opener).toContain("setEditAtlasOpen(false)");
    expect(opener).toContain("setPasswordSurface(null)");
    expect(opener).toContain("setIdentityOpen(false)");
  });

  it("opens the desktop dock when the provider return reveals the identity panel", () => {
    // .account-dock__panel stays display:none until the dock is open, so a
    // return that only set identityOpen rendered its outcome invisibly.
    expect(shouldOpenDockForRevealedPanel(false)).toBe(true);
    expect(shouldOpenDockForRevealedPanel(true)).toBe(false);
    const auth = readFileSync("src/auth/AuthGateway.tsx", "utf8");
    const effect = auth.slice(
      auth.indexOf("const result = readProviderBindReturn(window.location.hash);"),
      auth.indexOf("setBindReturn(result);"),
    );
    expect(effect).not.toBe("");
    expect(effect).toContain("shouldOpenDockForRevealedPanel(isMobileV2)");
    expect(effect).toContain("setDockOpen(true)");
  });

  it("opens the recovery mode for a signed-out person whose link expired", () => {
    const auth = readFileSync("src/auth/AuthGateway.tsx", "utf8");
    // An expired link is routinely opened in another browser or after the
    // session ended, where the account surface never mounts.
    expect(auth).toContain(
      'accountSurfaceFromLocationSearch(window.location.search) ? "forgot" : "sign-in"',
    );
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
