import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  canReadCurrentAtlasEarly,
  gateFromCurrentAtlas,
  gateFromOrganizationList,
  readCurrentAtlas,
  type CurrentAtlasRead,
  type OrganizationSummary,
} from "./workspaceGate";

const organization: OrganizationSummary = { id: "org-1", name: "Our Atlas", slug: "our-atlas" };
const atlas = { id: "atlas-1", title: "Our Atlas", dedication: "" };
const ready: CurrentAtlasRead = { kind: "ready", atlas, role: "owner" };

function respond(status: number, body: unknown): typeof fetch {
  return (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;
}

describe("workspace gate load decision", () => {
  it("reads the Atlas early only when an active Organization is known", () => {
    expect(canReadCurrentAtlasEarly("org-1")).toBe(true);
    expect(canReadCurrentAtlasEarly(null)).toBe(false);
    expect(canReadCurrentAtlasEarly(undefined)).toBe(false);
    expect(canReadCurrentAtlasEarly("")).toBe(false);
  });

  it("lets every list outcome win over an Atlas read that already succeeded", () => {
    // An early Atlas read can finish first; it must never mask the list.
    expect(gateFromOrganizationList({ error: { message: "list down" } }, "org-1"))
      .toEqual({ gate: { kind: "error", message: "list down" } });
    expect(gateFromOrganizationList({ error: {} }, "org-1"))
      .toEqual({ gate: { kind: "error", message: "无法读取图谱列表" } });
    expect(gateFromOrganizationList({ data: [] }, "org-1"))
      .toEqual({ gate: { kind: "create-organization" } });
    expect(gateFromOrganizationList({ data: null }, "org-1"))
      .toEqual({ gate: { kind: "create-organization" } });
    expect(gateFromOrganizationList({ data: [organization] }, "org-other"))
      .toEqual({ gate: { kind: "choose-organization", organizations: [organization] } });
    expect(gateFromOrganizationList({ data: [organization] }, "org-1"))
      .toEqual({ active: organization });
  });

  it("maps the Atlas read once the list confirms the active Organization", () => {
    expect(gateFromCurrentAtlas(organization, ready)).toEqual({ kind: "ready", atlas, role: "owner" });
    expect(gateFromCurrentAtlas(organization, { kind: "missing" }))
      .toEqual({ kind: "bootstrap", organization });
    expect(gateFromCurrentAtlas(organization, { kind: "failed", message: "Atlas permission denied" }))
      .toEqual({ kind: "error", message: "Atlas permission denied" });
  });

  it("classifies the Atlas response without ever rejecting", async () => {
    await expect(readCurrentAtlas(respond(200, { atlas, role: "member" })))
      .resolves.toEqual({ kind: "ready", atlas, role: "member" });
    await expect(readCurrentAtlas(respond(404, { error: "ATLAS_NOT_FOUND", message: "Atlas not found" })))
      .resolves.toEqual({ kind: "missing" });
    // Any other 404 is a failure, not a bootstrap invitation.
    await expect(readCurrentAtlas(respond(404, { error: "Not found" })))
      .resolves.toEqual({ kind: "failed", message: "Not found" });
    await expect(readCurrentAtlas(respond(403, { error: "ATLAS_MEMBERSHIP_REQUIRED", message: "Atlas membership required" })))
      .resolves.toEqual({ kind: "failed", message: "Atlas membership required" });
    await expect(readCurrentAtlas((async () => new Response("<html>", { status: 502 })) as typeof fetch))
      .resolves.toEqual({ kind: "failed", message: "无法读取私人图谱" });
    // A network failure used to reject inside the gate effect and leave the
    // gate loading forever; started early, it must surface as an error state.
    await expect(readCurrentAtlas((async () => { throw new TypeError("network"); }) as typeof fetch))
      .resolves.toEqual({ kind: "failed", message: "无法读取私人图谱" });
  });

  it("starts the Atlas read before awaiting the list, and decides by the list first", () => {
    const gateway = readFileSync("src/auth/AuthGateway.tsx", "utf8");
    const early = gateway.indexOf("const earlyAtlas = canReadCurrentAtlasEarly(selectedActiveId) ? readCurrentAtlas() : null;");
    const listed = gateway.indexOf("const listed = await authClient.organization.list();");
    const verdict = gateway.indexOf("const listVerdict = gateFromOrganizationList(listed, selectedActiveId);");
    const current = gateway.indexOf("const current = await (earlyAtlas ?? readCurrentAtlas());");
    expect(early).toBeGreaterThan(-1);
    expect(early).toBeLessThan(listed);
    expect(listed).toBeLessThan(verdict);
    expect(verdict).toBeLessThan(current);
  });
});
