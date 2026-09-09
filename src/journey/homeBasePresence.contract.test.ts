import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(path, "utf8");

describe("Home Base V1 negative contracts (#233)", () => {
  it("keeps Home Base labels out of every JourneyTimeline row", () => {
    const source = read("src/journey/JourneyTimeline.tsx");
    expect(source).not.toMatch(/homeBase|home-base|home_base|常住地/);
  });

  it("adds no permanent Home Base export or control to compact mobile", () => {
    const mobileLayout = read("src/journey/mobileLayout.ts");
    const compactContract = read("src/journey/compactMobileContract.test.ts");
    expect(mobileLayout).not.toMatch(/homeBase|home-base|home_base|常住地/);
    expect(compactContract).not.toMatch(/homeBase|home-base|home_base|常住地/);
  });

  it("keeps Home Base fields out of the guest Journey payload contract", () => {
    const repository = read("server/repositories/shared-journey-repository.ts");
    const test = read("server/repositories/shared-journey-repository.test.ts");
    expect(repository).not.toMatch(/homeBase|home-base|home_base|常住地/);
    expect(test).not.toMatch(/homeBase|home-base|home_base|常住地/);
    expect(test).toContain("expect(Object.keys(view.journeys[0]).sort()).toEqual([");
  });
});
