import { describe, expect, it } from "vitest";
import { activateAccountScope, sessionGuard } from "../../mobile/soc/src/accountScope";

describe("device account scope", () => {
  it("invalidates work from a signed-out user, even when the same user signs back in", () => {
    activateAccountScope("alice");
    const oldLesson = sessionGuard();
    activateAccountScope("");
    activateAccountScope("alice");
    expect(oldLesson).toThrow();
    expect(sessionGuard()).not.toThrow();
    activateAccountScope("bob");
    expect(oldLesson).toThrow();
    activateAccountScope("");
    expect(() => sessionGuard()).toThrow();
  });
});
