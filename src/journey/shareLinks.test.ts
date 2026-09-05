import { describe, expect, it } from "vitest";
import {
  MAX_SHARE_JOURNEYS,
  MAX_SHARE_LIFETIME_MS,
  SHARE_BEARER_NOTICE,
  SHARE_EXPIRY_PRESETS,
  SHARE_TOKEN_ONCE_NOTICE,
  activeShareRows,
  deriveShareStatus,
  MAX_TIMEOUT_DELAY_MS,
  formatShareExpiry,
  maxCustomExpiry,
  nextShareExpiryDelay,
  resolveShareExpiry,
  shareExpiryMessage,
  shareLinkRow,
  shareLinkUrl,
  shareScopeLabel,
  shareSelectionMessage,
  toDateTimeLocalValue,
  toggleShareSelection,
} from "./shareLinks";
import type { ShareGrantSummary } from "./types";

const NOW = new Date("2026-09-05T04:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

function grant(overrides: Partial<ShareGrantSummary> = {}): ShareGrantSummary {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    createdAt: "2026-09-01T00:00:00.000Z",
    expiresAt: "2026-10-10T10:30:00.000Z",
    revokedAt: null,
    lastAccessedAt: null,
    status: "active",
    journeyCount: 1,
    journeys: [{ id: "journey-a", title: "海风经过深圳湾" }],
    ...overrides,
  };
}

describe("resolveShareExpiry", () => {
  it("measures every preset from the instant of the request", () => {
    for (const preset of SHARE_EXPIRY_PRESETS) {
      if (preset.days === null) continue;
      const resolved = resolveShareExpiry(preset.id, NOW);
      expect(resolved.ok).toBe(true);
      if (!resolved.ok) return;
      expect(resolved.expiresAt.valueOf() - NOW.valueOf()).toBe(preset.days * DAY_MS);
    }
  });

  it("offers exactly the #200 V1 presets and no permanent option", () => {
    expect(SHARE_EXPIRY_PRESETS.map((preset) => preset.id))
      .toEqual(["1d", "7d", "30d", "custom"]);
    // A permanent link must be an explicit product decision, so the option a
    // careless click could reach must not exist at all.
    expect(SHARE_EXPIRY_PRESETS.some((preset) => preset.days === Infinity)).toBe(false);
    for (const preset of SHARE_EXPIRY_PRESETS) {
      if (preset.days === null) continue;
      expect(preset.days * DAY_MS).toBeLessThanOrEqual(MAX_SHARE_LIFETIME_MS);
    }
  });

  it("names which bound a custom value crossed", () => {
    expect(resolveShareExpiry("custom", NOW)).toEqual({ ok: false, reason: "custom-missing" });
    expect(resolveShareExpiry("custom", NOW, "not a date"))
      .toEqual({ ok: false, reason: "custom-invalid" });
    expect(resolveShareExpiry("custom", NOW, "2026-09-05T04:00:30.000Z"))
      .toEqual({ ok: false, reason: "too-soon" });
    expect(resolveShareExpiry("custom", NOW, "2029-01-01T00:00:00.000Z"))
      .toEqual({ ok: false, reason: "too-far" });
  });

  it("accepts a custom value exactly at the server ceiling", () => {
    const ceiling = new Date(NOW.valueOf() + MAX_SHARE_LIFETIME_MS);
    const resolved = resolveShareExpiry("custom", NOW, ceiling.toISOString());
    expect(resolved.ok).toBe(true);
    expect(maxCustomExpiry(NOW).valueOf()).toBe(ceiling.valueOf());
  });

  it("gives every failure a sentence the owner can act on", () => {
    for (const reason of ["custom-missing", "custom-invalid", "too-soon", "too-far"] as const) {
      expect(shareExpiryMessage(reason).length).toBeGreaterThan(0);
    }
  });
});

describe("toDateTimeLocalValue", () => {
  it("writes local wall-clock text, not a UTC instant", () => {
    const value = new Date(2026, 9, 10, 18, 30);
    expect(toDateTimeLocalValue(value)).toBe("2026-10-10T18:30");
  });
});

describe("formatShareExpiry", () => {
  it("shows the exact minute rather than a relative phrase", () => {
    const value = new Date(2026, 9, 10, 18, 30);
    expect(formatShareExpiry(value)).toBe("2026-10-10 18:30");
    expect(formatShareExpiry(value.toISOString())).toBe("2026-10-10 18:30");
  });

  it("says nothing rather than NaN for an unusable value", () => {
    expect(formatShareExpiry("not a date")).toBe("");
  });
});

describe("shareLinkUrl", () => {
  it("puts the token in the fragment, per the #200 design amendment", () => {
    const url = shareLinkUrl("https://startrips.example", "token-value");
    expect(url).toBe("https://startrips.example/share#token-value");
    // A fragment is never sent to a server. If the token ever moved into the
    // path or the query it would land in the edge access log on every request,
    // which is the exact leak the amendment removed.
    expect(new URL(url).pathname).toBe("/share");
    expect(new URL(url).search).toBe("");
    expect(new URL(url).hash).toBe("#token-value");
  });

  it("does not double the separator for an origin with a trailing slash", () => {
    expect(shareLinkUrl("https://startrips.example/", "abc"))
      .toBe("https://startrips.example/share#abc");
  });
});

describe("shareScopeLabel", () => {
  it("lists one or two titles and counts beyond that", () => {
    expect(shareScopeLabel([{ title: "A" }], 1)).toBe("A");
    expect(shareScopeLabel([{ title: "A" }, { title: "B" }], 2)).toBe("A · B");
    expect(shareScopeLabel([{ title: "A" }, { title: "B" }, { title: "C" }], 3))
      .toBe("A · B 等 3 段旅程");
  });

  it("falls back to the count when no title survives", () => {
    expect(shareScopeLabel([], 3)).toBe("3 段旅程");
  });
});

describe("deriveShareStatus", () => {
  it("takes an open panel out of active when the grant expires under it", () => {
    const row = { status: "active" as const, expiresAt: "2026-09-05T03:59:00.000Z" };
    expect(deriveShareStatus(row, NOW)).toBe("expired");
  });

  it("keeps the server answer as the floor", () => {
    // The client clock may only remove `active`, never restore it: only the
    // server can know a grant was revoked or its Atlas went away.
    expect(deriveShareStatus(
      { status: "revoked", expiresAt: "2030-01-01T00:00:00.000Z" },
      NOW,
    )).toBe("revoked");
    expect(deriveShareStatus(
      { status: "atlas-unavailable", expiresAt: "2030-01-01T00:00:00.000Z" },
      NOW,
    )).toBe("atlas-unavailable");
  });

  it("stays active while the expiry is still ahead", () => {
    expect(deriveShareStatus(
      { status: "active", expiresAt: "2026-10-10T10:30:00.000Z" },
      NOW,
    )).toBe("active");
  });
});

describe("shareLinkRow", () => {
  it("carries no token field of any kind", () => {
    const row = shareLinkRow(grant(), NOW);
    // #200 hashes the token at rest, so a raw one exists exactly once, in the
    // create response. A row model that cannot carry one cannot grow a
    // copy-again affordance that would need that storage weakened to work.
    expect(Object.keys(row).sort()).toEqual([
      "active",
      "createdAt",
      "expiryLabel",
      "id",
      "journeyCount",
      "scopeLabel",
      "status",
      "statusLabel",
    ]);
    expect(JSON.stringify(row).toLowerCase()).not.toContain("token");
  });

  it("shows the exact expiry and a readable scope", () => {
    const row = shareLinkRow(grant(), NOW);
    expect(row.expiryLabel).toBe(formatShareExpiry("2026-10-10T10:30:00.000Z"));
    expect(row.scopeLabel).toBe("海风经过深圳湾");
    expect(row.active).toBe(true);
    expect(row.statusLabel).toBe("有效");
  });
});

describe("activeShareRows", () => {
  it("lists only what a recipient could still open, newest first", () => {
    const rows = activeShareRows([
      grant({ id: "older", createdAt: "2026-09-01T00:00:00.000Z" }),
      grant({ id: "newer", createdAt: "2026-09-04T00:00:00.000Z" }),
      grant({ id: "revoked", status: "revoked", revokedAt: "2026-09-02T00:00:00.000Z" }),
      grant({ id: "expired", expiresAt: "2026-09-04T00:00:00.000Z" }),
    ], NOW);
    expect(rows.map((row) => row.id)).toEqual(["newer", "older"]);
  });

  it("drops a link the moment it is revoked, which is what revoke must look like", () => {
    const before = activeShareRows([grant({ id: "one" })], NOW);
    expect(before.map((row) => row.id)).toEqual(["one"]);
    const after = activeShareRows(
      [grant({ id: "one", status: "revoked", revokedAt: "2026-09-05T03:00:00.000Z" })],
      NOW,
    );
    expect(after).toEqual([]);
  });
});

describe("share selection", () => {
  it("toggles a Journey id in and out of its own set", () => {
    expect(toggleShareSelection([], "a")).toEqual(["a"]);
    expect(toggleShareSelection(["a"], "b")).toEqual(["a", "b"]);
    expect(toggleShareSelection(["a", "b"], "a")).toEqual(["b"]);
  });

  it("refuses an empty or over-large selection with a sentence", () => {
    expect(shareSelectionMessage(0)).toBe("请至少选择一段旅程。");
    expect(shareSelectionMessage(1)).toBeNull();
    expect(shareSelectionMessage(MAX_SHARE_JOURNEYS)).toBeNull();
    expect(shareSelectionMessage(MAX_SHARE_JOURNEYS + 1)).not.toBeNull();
  });

  it("treats a single Journey as a selection of size one", () => {
    // #200's invariant: single and multi sharing are the same capability model
    // at different cardinality, so nothing here special-cases a count of one.
    expect(shareSelectionMessage(1)).toBeNull();
    expect(shareScopeLabel([{ title: "A" }], 1)).toBe("A");
  });
});

describe("owner copy", () => {
  it("states that the link forwards access, and that it is shown once", () => {
    expect(SHARE_BEARER_NOTICE).toContain("任何获得此链接的人");
    expect(SHARE_BEARER_NOTICE).toContain("有效期内查看");
    expect(SHARE_BEARER_NOTICE).toContain("不能编辑");
    expect(SHARE_TOKEN_ONCE_NOTICE).toContain("只在创建时显示一次");
  });
});

describe("nextShareExpiryDelay", () => {
  it("schedules the re-derivation for the nearest expiry", () => {
    const delay = nextShareExpiryDelay([
      grant({ id: "later", expiresAt: "2026-09-05T06:00:00.000Z" }),
      grant({ id: "sooner", expiresAt: "2026-09-05T05:00:00.000Z" }),
    ], NOW);
    expect(delay).toBe(60 * 60 * 1000 + 1_000);
  });

  it("ignores grants that are already inactive or already past", () => {
    expect(nextShareExpiryDelay([
      grant({ status: "revoked", expiresAt: "2026-09-05T05:00:00.000Z" }),
      grant({ expiresAt: "2026-09-05T03:00:00.000Z" }),
      grant({ expiresAt: "not a date" }),
    ], NOW)).toBeNull();
  });

  it("returns null when there is nothing that will change on its own", () => {
    expect(nextShareExpiryDelay([], NOW)).toBeNull();
  });

  it("caps a far-future expiry rather than letting the timer fire at once", () => {
    // A delay past the 32-bit ceiling is clamped by `setTimeout` and fires
    // immediately, which would spin the panel instead of waiting.
    const delay = nextShareExpiryDelay(
      [grant({ expiresAt: new Date(NOW.valueOf() + MAX_SHARE_LIFETIME_MS).toISOString() })],
      NOW,
    );
    expect(delay).toBe(MAX_TIMEOUT_DELAY_MS);
    expect(MAX_SHARE_LIFETIME_MS).toBeGreaterThan(MAX_TIMEOUT_DELAY_MS);
  });
});
