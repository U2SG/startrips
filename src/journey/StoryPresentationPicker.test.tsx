import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StoryPresentationPicker } from "./StoryPresentationPicker";
import { SharedMediaPresentationProvider } from "./MediaPresentationProvider";

describe("Story presentation entry", () => {
  it("makes the exact render-loop patch available before Docker installs dependencies", () => {
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
    expect(pkg.dependencies["page-flip"]).toBe("2.0.7");
    expect(pkg.pnpm.patchedDependencies["page-flip@2.0.7"]).toBe("patches/page-flip@2.0.7.patch");
    const docker = readFileSync(new URL("../../Dockerfile", import.meta.url), "utf8");
    expect(docker.indexOf("COPY patches ./patches")).toBeGreaterThan(-1);
    expect(docker.indexOf("COPY patches ./patches")).toBeLessThan(docker.indexOf("RUN pnpm install --frozen-lockfile"));
  });

  it("offers every presentation directly in the standalone owner-compatible entry", () => {
    const html = renderToStaticMarkup(createElement(StoryPresentationPicker));
    expect(html).toContain('aria-label="切换媒体呈现"');
    for (const style of ["classic", "note-overlay", "book", "book-3d", "stream"]) expect(html).toContain(`value="${style}"`);
    expect((html.match(/<option /g) ?? []).length).toBe(5);
  });
  it("does not expand a shared reader's presentation authority", () => {
    const html = renderToStaticMarkup(createElement(SharedMediaPresentationProvider, {
      style: "book", children: createElement(StoryPresentationPicker, { onOpenClassic: () => undefined }),
    }));
    expect(html).not.toContain("<select");
    expect(html).toContain("经典视图");
  });
  it("omits a shared entry with no recovery action", () => {
    expect(renderToStaticMarkup(createElement(SharedMediaPresentationProvider, {
      style: "classic", children: createElement(StoryPresentationPicker),
    }))).toBe("");
  });
});
