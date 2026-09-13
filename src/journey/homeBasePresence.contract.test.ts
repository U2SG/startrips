import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(path, "utf8");
const HOME_IDENTIFIER_PATTERN = /homeBase|home-base|home_base|常住地/i;

describe("Home Base V1 negative contracts (#233)", () => {
  it("detects mixed-case and constant-style Home identifier families", () => {
    expect("HomeBasePeriod").toMatch(HOME_IDENTIFIER_PATTERN);
    expect("HOME_BASE_ID").toMatch(HOME_IDENTIFIER_PATTERN);
    expect("home-base-control").toMatch(HOME_IDENTIFIER_PATTERN);
  });

  it("keeps Home Base labels out of every JourneyTimeline row", () => {
    const source = read("src/journey/JourneyTimeline.tsx");
    expect(source).not.toMatch(HOME_IDENTIFIER_PATTERN);
  });

  it("adds no permanent Home Base export or control to compact mobile", () => {
    const mobileLayout = read("src/journey/mobileLayout.ts");
    const compactContract = read("src/journey/compactMobileContract.test.ts");
    expect(mobileLayout).not.toMatch(HOME_IDENTIFIER_PATTERN);
    expect(compactContract).not.toMatch(HOME_IDENTIFIER_PATTERN);
  });

  it("keeps Home Base fields out of the guest Journey payload contract", () => {
    const repository = read("server/repositories/shared-journey-repository.ts");
    const test = read("server/repositories/shared-journey-repository.test.ts");
    expect(repository).not.toMatch(HOME_IDENTIFIER_PATTERN);
    // The guest contract test is allowed to name private Home Base fields so it
    // can prove they are absent from the serialized DTO. Keep the production
    // repository free of those identifiers, and require the explicit no-leak
    // assertions instead of banning the assertion vocabulary itself.
    expect(test).toContain("carries no Home Base suggestion, dismissal, metro anchor or confirmed period field");
    expect(test).toContain('"homeBase"');
    expect(test).toContain('"home_base"');
    expect(test).toContain('"homeBasePeriods"');
    expect(test).toContain("expect(Object.keys(view.journeys[0]).sort()).toEqual([");
  });
});
