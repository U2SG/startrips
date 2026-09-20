import { describe, expect, it } from "vitest";
import {
  accountSurfaceEyebrow,
  accountSurfaceTitle,
  isAccountFormSurface,
  previousAccountSurface,
  type AccountSurface,
} from "./accountSurface";

const DRILL: AccountSurface[] = ["invite", "edit", "password-change", "password-enroll"];

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

  it("labels each surface distinctly instead of inheriting the Atlas heading", () => {
    const titles = DRILL.map(accountSurfaceTitle);
    expect(new Set(titles).size).toBe(DRILL.length);
    expect(accountSurfaceTitle("password-change")).toBe("修改密码");
    expect(accountSurfaceTitle("password-enroll")).toBe("设置密码");
    expect(accountSurfaceEyebrow("password-change")).toBe("ACCOUNT SECURITY");
    expect(accountSurfaceEyebrow("password-enroll")).toBe("ACCOUNT SECURITY");
    expect(accountSurfaceEyebrow("invite")).toBe("INVITATION");
    expect(accountSurfaceEyebrow("edit")).toBe("ATLAS DETAILS");
  });
});
