import { describe, expect, it, vi } from "vitest";

// The full app module pulls in the better-auth client, which needs a browser
// runtime; mock the auth capability hook so the pure focus-state helper can
// be imported in the node test environment.
vi.mock("../auth/AuthGateway", () => ({
  useAtlasCapabilities: () => ({ canDeleteJourney: false }),
}));

import { globeFocusState } from "./LivingAtlasApp";

// #8 globe focus mode: the root class/data contract drives the layout CSS
// (sidebars hidden, globe raised, exit control visible). The full app mounts
// async and is covered by the browser QA script; this keeps the toggle logic
// pure and unit-tested.
describe("globeFocusState (#8)", () => {
  it("is off by default and carries the data attribute for layout CSS", () => {
    expect(globeFocusState(false)).toEqual({
      className: "",
      dataAttribute: "off",
    });
  });

  it("adds the focus class and flips the data attribute when enabled", () => {
    expect(globeFocusState(true)).toEqual({
      className: " is-globe-focus",
      dataAttribute: "on",
    });
  });
});
