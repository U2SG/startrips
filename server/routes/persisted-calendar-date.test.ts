import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

const repositorySpies = vi.hoisted(() => ({
  createHomeBasePeriodForAtlas: vi.fn(),
  updateHomeBasePeriodForAtlas: vi.fn(),
  createJourneyForAtlas: vi.fn(),
}));

vi.mock("../authorization/atlas-access", () => ({
  requireAtlasAccess: vi.fn(async () => ({
    atlas: { id: "11111111-1111-4111-8111-111111111111" },
    session: { user: { id: "22222222-2222-4222-8222-222222222222" } },
  })),
}));

vi.mock("../repositories/home-base-repository", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../repositories/home-base-repository")>();
  return {
    ...actual,
    createHomeBasePeriodForAtlas: repositorySpies.createHomeBasePeriodForAtlas,
    updateHomeBasePeriodForAtlas: repositorySpies.updateHomeBasePeriodForAtlas,
  };
});

vi.mock("../repositories/journey-repository", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../repositories/journey-repository")>();
  return {
    ...actual,
    createJourneyForAtlas: repositorySpies.createJourneyForAtlas,
  };
});

import { homeBaseRoutes } from "./home-bases";
import { journeyRoutes } from "./journeys";

const app = new Hono();
app.route("/api/home-bases", homeBaseRoutes);
app.route("/api/journeys", journeyRoutes);

const headers = { "content-type": "application/json" };
const periodId = "33333333-3333-4333-8333-333333333333";

function homeBody(overrides: Record<string, unknown> = {}) {
  return {
    label: "Shenzhen",
    latitude: 22.543096,
    longitude: 114.057865,
    startedOn: "2026-01-01",
    ...overrides,
  };
}

function journeyBody(overrides: Record<string, unknown> = {}) {
  return {
    title: "Calendar boundary",
    startedOn: "2026-01-01",
    endedOn: null,
    note: "",
    lightColor: "#f4ce73",
    routePoints: [{
      latitude: 22.543096,
      longitude: 114.057865,
      label: "",
      isStop: false,
      occurredAt: null,
    }],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("persisted calendar-date route boundary", () => {
  it("POST /api/home-bases rejects year zero before a repository write", async () => {
    const response = await app.request("/api/home-bases", {
      method: "POST",
      headers,
      body: JSON.stringify(homeBody({ startedOn: "0000-01-01" })),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "INVALID_HOME_BASE" });
    expect(repositorySpies.createHomeBasePeriodForAtlas).not.toHaveBeenCalled();
  });

  it.each([
    ["startedOn", { startedOn: "0000-01-01" }],
    ["endedOn", { endedOn: "0000-01-01" }],
  ])("PATCH /api/home-bases rejects year zero in %s before a repository write", async (_field, patch) => {
    const response = await app.request(`/api/home-bases/${periodId}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify(patch),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "INVALID_HOME_BASE" });
    expect(repositorySpies.updateHomeBasePeriodForAtlas).not.toHaveBeenCalled();
  });

  it("POST /api/journeys rejects a year-zero startedOn before a repository write", async () => {
    const response = await app.request("/api/journeys", {
      method: "POST",
      headers,
      body: JSON.stringify(journeyBody({ startedOn: "0000-01-01" })),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "INVALID_JOURNEY" });
    expect(repositorySpies.createJourneyForAtlas).not.toHaveBeenCalled();
  });
});
