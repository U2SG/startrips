/**
 * The workspace gate's load decision, kept pure so its precedence is tested.
 *
 * Two reads decide the gate: the member's Organization list and the session's
 * current Atlas. They are independent on the server — `/api/atlases/current`
 * resolves the Atlas from the session's active Organization, never from the
 * list — so the client may start both at once. What must not change is the
 * order in which their outcomes decide the gate: the list's error, empty and
 * not-yet-chosen states always win, and the Atlas outcome only matters once
 * the list confirms the active Organization.
 */

export type OrganizationSummary = {
  id: string;
  name: string;
  slug: string;
};

export type AtlasSummary = {
  id: string;
  title: string;
  dedication: string;
};

export type GateState =
  | { kind: "loading" }
  | { kind: "create-organization" }
  | { kind: "choose-organization"; organizations: OrganizationSummary[] }
  | { kind: "bootstrap"; organization: OrganizationSummary }
  | { kind: "ready"; atlas: AtlasSummary; role: string }
  | { kind: "error"; message: string };

export type OrganizationListResult = {
  data?: OrganizationSummary[] | null;
  error?: { message?: string } | null;
};

export type CurrentAtlasRead =
  | { kind: "ready"; atlas: AtlasSummary; role: string }
  | { kind: "missing" }
  | { kind: "failed"; message: string };

const CURRENT_ATLAS_FAILED = "无法读取私人图谱";

/**
 * Whether the current Atlas can be read before the list answers. Without a
 * known active Organization the list alone decides (create or choose), so a
 * concurrent read would be wasted work that can only fail.
 */
export function canReadCurrentAtlasEarly(activeOrganizationId: string | null | undefined) {
  return Boolean(activeOrganizationId);
}

/**
 * One read of the current Atlas that never rejects, so starting it before it
 * is needed can neither surface an unhandled rejection nor hang the gate.
 */
export async function readCurrentAtlas(fetcher: typeof fetch = fetch): Promise<CurrentAtlasRead> {
  try {
    const response = await fetcher("/api/atlases/current", { credentials: "include" });
    if (response.ok) {
      const payload = await response.json() as { atlas: AtlasSummary; role: string };
      return { kind: "ready", atlas: payload.atlas, role: payload.role };
    }
    const error = await response.json().catch(() => null) as { error?: string; message?: string } | null;
    if (response.status === 404 && error?.error === "ATLAS_NOT_FOUND") return { kind: "missing" };
    return { kind: "failed", message: error?.message || error?.error || CURRENT_ATLAS_FAILED };
  } catch {
    return { kind: "failed", message: CURRENT_ATLAS_FAILED };
  }
}

/** The list's verdict: a final gate, or the confirmed active Organization. */
export function gateFromOrganizationList(
  listed: OrganizationListResult,
  activeOrganizationId: string | null | undefined,
): { gate: GateState } | { active: OrganizationSummary } {
  if (listed.error) {
    return { gate: { kind: "error", message: listed.error.message || "无法读取图谱列表" } };
  }
  const organizations = listed.data ?? [];
  if (organizations.length === 0) return { gate: { kind: "create-organization" } };
  const active = organizations.find((organization) => organization.id === activeOrganizationId);
  if (!active) return { gate: { kind: "choose-organization", organizations } };
  return { active };
}

/** The gate once the list has confirmed the active Organization. */
export function gateFromCurrentAtlas(active: OrganizationSummary, current: CurrentAtlasRead): GateState {
  if (current.kind === "ready") return { kind: "ready", atlas: current.atlas, role: current.role };
  if (current.kind === "missing") return { kind: "bootstrap", organization: active };
  return { kind: "error", message: current.message };
}
