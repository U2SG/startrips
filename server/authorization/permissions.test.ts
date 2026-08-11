import { describe, expect, it } from "vitest";
import { hasAtlasPermission } from "./permissions";

describe("atlas permissions", () => {
  it("allows both atlas members to read and contribute", () => {
    expect(hasAtlasPermission("owner", "create")).toBe(true);
    expect(hasAtlasPermission("member", "read")).toBe(true);
    expect(hasAtlasPermission("member", "update")).toBe(true);
  });

  it("reserves invitations and destructive operations for the owner", () => {
    expect(hasAtlasPermission("owner", "bootstrap")).toBe(true);
    expect(hasAtlasPermission("owner", "invite")).toBe(true);
    expect(hasAtlasPermission("owner", "delete")).toBe(true);
    expect(hasAtlasPermission("member", "bootstrap")).toBe(false);
    expect(hasAtlasPermission("member", "invite")).toBe(false);
    expect(hasAtlasPermission("member", "delete")).toBe(false);
  });

  it("does not grant access to unknown or empty roles", () => {
    expect(hasAtlasPermission("admin", "read")).toBe(false);
    expect(hasAtlasPermission("", "read")).toBe(false);
  });
});
