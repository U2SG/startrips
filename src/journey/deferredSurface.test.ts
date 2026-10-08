import { describe, expect, it, vi } from "vitest";
import { createModuleLoader } from "./deferredSurface";

describe("createModuleLoader", () => {
  it("imports once and then serves the module synchronously", async () => {
    const importer = vi.fn(async () => "module");
    const loader = createModuleLoader(importer);
    expect(loader.current()).toBeNull();
    const [first, second] = await Promise.all([loader.load(), loader.load()]);
    expect(first).toBe("module");
    expect(second).toBe("module");
    expect(loader.current()).toBe("module");
    await loader.load();
    expect(importer).toHaveBeenCalledTimes(1);
  });

  it("retries an import that failed instead of caching the failure", async () => {
    const importer = vi.fn()
      .mockRejectedValueOnce(new Error("chunk unavailable"))
      .mockResolvedValueOnce("module");
    const loader = createModuleLoader(importer);
    await expect(loader.load()).rejects.toThrow("chunk unavailable");
    expect(loader.current()).toBeNull();
    await expect(loader.load()).resolves.toBe("module");
    expect(importer).toHaveBeenCalledTimes(2);
  });
});
