import { describe, expect, it } from "vitest";
import {
  accountSurfaceEyebrow,
  accountSurfaceFromLocationSearch,
  accountSurfaceTitle,
  isAccountFormSurface,
  isPasswordLinkSurface,
  nextPasswordLinkSurface,
  passwordLinkSurfaceText,
  previousAccountSurface,
  EXPIRED_PASSWORD_LINK_QUERY,
  type AccountSurface,
} from "./accountSurface";

const LINK: AccountSurface[] = [
  "password-link-offered",
  "password-link-sent",
  "password-link-expired",
  "password-link-failed",
];
const DRILL: AccountSurface[] = ["invite", "edit", "password-change", ...LINK];

describe("account surface transitions", () => {
  it("unwinds every drill surface to the account menu", () => {
    for (const surface of DRILL) {
      expect(previousAccountSurface(surface)).toBe("menu");
    }
    expect(previousAccountSurface("menu")).toBeNull();
    expect(previousAccountSurface(null)).toBeNull();
  });

  it("counts the password surfaces as forms so mobile back navigation covers them", () => {
    for (const surface of DRILL) {
      expect(isAccountFormSurface(surface)).toBe(true);
    }
    expect(isAccountFormSurface("menu")).toBe(false);
    expect(isAccountFormSurface(null)).toBe(false);
  });

  it("moves the set-password link flow between its own outcomes only", () => {
    expect(nextPasswordLinkSurface("password-link-offered", "sent")).toBe("password-link-sent");
    expect(nextPasswordLinkSurface("password-link-offered", "failed")).toBe("password-link-failed");
    expect(nextPasswordLinkSurface("password-link-sent", "expired")).toBe("password-link-expired");
    // Every terminal state can ask for another link.
    for (const surface of LINK) {
      expect(nextPasswordLinkSurface(surface, "resend")).toBe("password-link-offered");
      expect(isPasswordLinkSurface(surface)).toBe(true);
    }
    // A late outcome cannot drag another surface into the password flow.
    for (const surface of ["menu", "invite", "edit", "password-change", null] as AccountSurface[]) {
      expect(nextPasswordLinkSurface(surface, "sent")).toBe(surface);
      expect(isPasswordLinkSurface(surface)).toBe(false);
    }
  });

  it("opens on the expired state only for the reset page's non-secret marker", () => {
    expect(accountSurfaceFromLocationSearch(`?${EXPIRED_PASSWORD_LINK_QUERY}`))
      .toBe("password-link-expired");
    expect(EXPIRED_PASSWORD_LINK_QUERY).not.toContain("token");
    expect(accountSurfaceFromLocationSearch("?token=abc")).toBeNull();
    expect(accountSurfaceFromLocationSearch("")).toBeNull();
  });

  it("labels each flow distinctly instead of inheriting the Atlas heading", () => {
    expect(accountSurfaceTitle("password-change")).toBe("修改密码");
    expect(accountSurfaceTitle("invite")).toBe("邀请另一位");
    expect(accountSurfaceTitle("edit")).toBe("编辑图谱");
    for (const surface of LINK) {
      expect(accountSurfaceTitle(surface)).toBe("设置密码");
      expect(accountSurfaceEyebrow(surface)).toBe("ACCOUNT SECURITY");
    }
    expect(accountSurfaceEyebrow("password-change")).toBe("ACCOUNT SECURITY");
    expect(accountSurfaceEyebrow("invite")).toBe("INVITATION");
    expect(accountSurfaceEyebrow("edit")).toBe("ATLAS DETAILS");
  });

  it("gives every link outcome its own sentence and never names the route", () => {
    const texts = LINK.map(passwordLinkSurfaceText);
    expect(new Set(texts).size).toBe(LINK.length);
    for (const text of texts) {
      expect(text).not.toBe("");
      expect(text).not.toMatch(/enrollment|reverify|token/i);
    }
    expect(passwordLinkSurfaceText("password-change")).toBe("");
  });
});
