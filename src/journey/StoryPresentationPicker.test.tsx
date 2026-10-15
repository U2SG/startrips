import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StoryPresentationPicker } from "./StoryPresentationPicker";
import * as presentationAccess from "./MediaPresentationProvider";
import { SharedMediaPresentationProvider } from "./MediaPresentationProvider";

afterEach(() => vi.restoreAllMocks());

function expectIconOnlyAction(html: string, label: string) {
  expect(html).toContain(`aria-label="${label}"`);
  expect(html).toContain(`data-tooltip="${label}"`);
  expect(html).toContain("<svg");
  expect(html.replace(/<[^>]+>/g, "")).toBe("");
  expect(html).not.toContain("<select");
  expect(html).not.toContain("<option");
}

describe("Story presentation entry", () => {
  it("makes the exact render-loop patch available before Docker installs dependencies", () => {
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
    expect(pkg.dependencies["page-flip"]).toBe("2.0.7");
    expect(pkg.pnpm.patchedDependencies["page-flip@2.0.7"]).toBe("patches/page-flip@2.0.7.patch");
    const docker = readFileSync(new URL("../../Dockerfile", import.meta.url), "utf8");
    expect(docker.indexOf("COPY patches ./patches")).toBeGreaterThan(-1);
    expect(docker.indexOf("COPY patches ./patches")).toBeLessThan(docker.indexOf("RUN pnpm install --frozen-lockfile"));
  });

  it("offers an icon-only exit without a preference chooser", () => {
    const html = renderToStaticMarkup(createElement(StoryPresentationPicker, { onOpenClassic: () => undefined }));
    expectIconOnlyAction(html, "退出媒体呈现");
  });

  it("offers an icon-only return to the saved presentation, taking precedence over exit", () => {
    const html = renderToStaticMarkup(createElement(StoryPresentationPicker, {
      onOpenClassic: () => undefined, onReturnPresentation: () => undefined,
    }));
    expectIconOnlyAction(html, "进入媒体呈现");
    expect(html).not.toContain("退出媒体呈现");
    expect((html.match(/<button /g) ?? []).length).toBe(1);
  });

  it("disables the local action while the Story has an unfinished operation", () => {
    const html = renderToStaticMarkup(createElement(StoryPresentationPicker, {
      disabled: true, onReturnPresentation: () => undefined,
    }));
    expectIconOnlyAction(html, "进入媒体呈现");
    expect(html).toContain('disabled=""');
  });

  it("does not expand a shared reader's presentation authority", () => {
    const html = renderToStaticMarkup(createElement(SharedMediaPresentationProvider, {
      style: "book", children: createElement(StoryPresentationPicker, { onOpenClassic: () => undefined }),
    }));
    expectIconOnlyAction(html, "退出媒体呈现");
    expect(html).not.toContain("编辑");
    expect(html).not.toContain("导出");
  });

  it("keeps shared local re-entry available without account mutation authority", () => {
    const html = renderToStaticMarkup(createElement(SharedMediaPresentationProvider, {
      style: "stream", children: createElement(StoryPresentationPicker, { onReturnPresentation: () => undefined }),
    }));
    expectIconOnlyAction(html, "进入媒体呈现");
    expect(html).not.toContain('disabled=""');
  });

  it("omits an entry with no local navigation action or preference error", () => {
    expect(renderToStaticMarkup(createElement(StoryPresentationPicker))).toBe("");
    expect(renderToStaticMarkup(createElement(SharedMediaPresentationProvider, {
      style: "classic", children: createElement(StoryPresentationPicker),
    }))).toBe("");
  });

  it("keeps an account failure retry visible even without a local navigation action", () => {
    vi.spyOn(presentationAccess, "useMediaPresentationAccess").mockReturnValue({
      style: "book", busy: false, error: "无法确认设置已保存，请重试。",
      select: vi.fn(async () => undefined), retry: vi.fn(), recover: vi.fn(),
    });
    const html = renderToStaticMarkup(createElement(StoryPresentationPicker));
    expect(html).toContain('role="status"');
    expect(html).toContain('class="story-presentation-picker__error"');
    expect(html).toContain("无法确认设置已保存，请重试。");
    expect(html).toContain("重试");
    expect(html).not.toContain("<select");
    expect(html).not.toContain("退出媒体呈现");
    expect(html).not.toContain("进入媒体呈现");
  });

  it("keeps a read failure retry disabled together with guarded navigation", () => {
    vi.spyOn(presentationAccess, "useMediaPresentationAccess").mockReturnValue({
      style: "classic", busy: false, error: "无法读取媒体呈现设置，请重试。",
      select: null, retry: vi.fn(), recover: vi.fn(),
    });
    const html = renderToStaticMarkup(createElement(StoryPresentationPicker, {
      disabled: true, onOpenClassic: () => undefined,
    }));
    expect(html).toContain("无法读取媒体呈现设置，请重试。");
    expect((html.match(/disabled=""/g) ?? []).length).toBe(2);
    expect(html).not.toContain("<select");
  });
});
