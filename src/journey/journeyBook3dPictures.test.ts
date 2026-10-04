import { describe, expect, it } from "vitest";
import { loadPictureChain, type PictureChainSteps } from "./journeyBook3dPictures";

function harness(options: {
  fails?: readonly string[];
  plainLoads?: boolean;
  isLive?: () => boolean;
  probe?: () => Promise<boolean>;
}) {
  const calls: string[] = [];
  const steps: PictureChainSteps<string> = {
    load: async (url) => {
      if (options.fails?.includes(url)) throw new Error("load failed");
      return url;
    },
    loadsWithoutCors: async (url) => {
      calls.push(`probe:${url}`);
      return options.probe ? options.probe() : Boolean(options.plainLoads);
    },
    isLive: options.isLive ?? (() => true),
    present: (picture) => calls.push(`present:${picture}`),
    onComplete: () => calls.push("complete"),
    onCorsRefused: () => calls.push("cors-refused"),
    onExpire: () => calls.push("expire"),
  };
  return { calls, steps };
}

describe("loadPictureChain", () => {
  it("presents the preview, then the original", async () => {
    const { calls, steps } = harness({});
    await loadPictureChain(["preview", "original"], steps);
    expect(calls).toEqual(["present:preview", "present:original", "complete"]);
  });

  it("keeps a decoded preview when the original fails", async () => {
    const { calls, steps } = harness({ fails: ["original"], plainLoads: true });
    await loadPictureChain(["preview", "original"], steps);
    expect(calls).toEqual(["present:preview"]);
  });

  it("renews the read when nothing decoded", async () => {
    const { calls, steps } = harness({ fails: ["preview", "original"] });
    await loadPictureChain(["preview", "original"], steps);
    expect(calls).toEqual(["probe:original", "expire"]);
  });

  it("reports refused cross-origin reads when nothing decoded", async () => {
    const { calls, steps } = harness({ fails: ["original"], plainLoads: true });
    await loadPictureChain(["original"], steps);
    expect(calls).toEqual(["probe:original", "cors-refused"]);
  });

  it("reports nothing when the page was left during the probe", async () => {
    let live = true;
    const { calls, steps } = harness({
      fails: ["original"],
      isLive: () => live,
      probe: async () => {
        live = false;
        return true;
      },
    });
    await loadPictureChain(["original"], steps);
    expect(calls).toEqual(["probe:original"]);
  });

  it("presents nothing that decoded after the page was left", async () => {
    let live = true;
    const { calls, steps } = harness({ isLive: () => live });
    const done = loadPictureChain(["preview", "original"], steps);
    live = false;
    await done;
    expect(calls).toEqual([]);
  });
});
