import { describe, expect, it, vi } from "vitest";
import { uploadJourneyMedia } from "./journeyMediaUpload";
import type { UploadedMediaAsset } from "../api/multipartUpload";

const files = ["first.jpg", "second.jpg", "third.jpg"].map((name) => new File([name], name, { type: "image/jpeg" }));
const asset = (id: string): UploadedMediaAsset => ({
  id, journeyId: "journey", routePointId: null, fileName: "same.jpg", mimeType: "image/jpeg", bytes: 1,
});

describe("per-asset upload confirmation", () => {
  it("confirms original indexes exactly once, before the next deferred file finishes", async () => {
    const confirmed: Array<{ fileIndex: number; asset: UploadedMediaAsset }> = [];
    let release!: (value: UploadedMediaAsset) => void;
    let started!: () => void;
    const pending = new Promise<UploadedMediaAsset>((resolve) => { release = resolve; });
    const secondStarted = new Promise<void>((resolve) => { started = resolve; });
    const controller = new AbortController();
    const upload = vi.fn(async (options) => {
      if (options.fileName === "first.jpg") {
        options.onAssetConfirmed?.(asset("confirmed"));
        return asset("confirmed");
      }
      started();
      return pending;
    });
    const running = uploadJourneyMedia({ journeyId: "journey", files, upload, signal: controller.signal,
      onAssetConfirmed: (value) => confirmed.push(value) });
    await secondStarted;
    expect(confirmed.map((value) => [value.fileIndex, value.asset.id])).toEqual([[0, "confirmed"]]);
    controller.abort();
    release(asset("late-server-confirmation"));
    await running;
    expect(upload).toHaveBeenCalledTimes(2); // third file never starts
    // A true confirmation is still reported at the boundary; the detached
    // Story owner must reject it using its captured lifetime and journal CAS.
    expect(confirmed.map((value) => value.fileIndex)).toEqual([0, 1]);
  });

  it("never confirms a thrown/unknown write or an asset without a matching Journey identity", async () => {
    const onAssetConfirmed = vi.fn();
    const upload = vi.fn().mockRejectedValueOnce(new Error("unknown response"))
      .mockResolvedValueOnce({ ...asset("foreign"), journeyId: "other" })
      .mockResolvedValueOnce(asset("known"));
    await uploadJourneyMedia({ journeyId: "journey", files, upload, onAssetConfirmed });
    expect(onAssetConfirmed).toHaveBeenCalledTimes(1);
    expect(onAssetConfirmed).toHaveBeenCalledWith({ fileIndex: 2, asset: asset("known") });
  });
});
