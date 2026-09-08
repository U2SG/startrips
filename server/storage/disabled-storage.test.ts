import { describe, expect, it } from "vitest";
import { disabledStorage } from "./disabled-storage";
import { StorageUnavailableError } from "./multipart-storage";

/**
 * #265: `STORAGE_DRIVER=disabled` has to stay honest about the one capability
 * completion now depends on.
 *
 * Every other method here has always thrown, but a read is the method most
 * tempting to soften: `{ exists: false }` looks like a harmless answer and is
 * the same shape a genuinely absent object returns. It is not harmless.
 * Completion treats an absent object as retryable, so a deployment holding no
 * object storage at all would leave previews `pending` forever while reporting
 * nothing wrong.
 */
describe("#265 the disabled storage driver's object head read", () => {
  it("throws StorageUnavailableError instead of answering with bytes", async () => {
    await expect(
      disabledStorage.readObjectHead({ key: "previews/anything", maxBytes: 64 }),
    ).rejects.toBeInstanceOf(StorageUnavailableError);
  });

  it("reports no object head as absent and returns no placeholder bytes", async () => {
    // Asserted as the absence of a resolved value rather than by inspecting
    // one, because there is no value: a driver that resolved at all here would
    // be inventing a result for storage this deployment does not have.
    const outcome = await disabledStorage
      .readObjectHead({ key: "previews/anything", maxBytes: 64 })
      .then(() => "resolved" as const, () => "threw" as const);
    expect(outcome).toBe("threw");
    expect(disabledStorage.driver).toBe("disabled");
  });
});
