import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { JournalOperationStatus } from "./JournalOperationStatus";

describe("journal operation status", () => {
  it("announces one supplied status with a reachable stop control", () => {
    const html = renderToStaticMarkup(createElement(JournalOperationStatus, { label: "正在整理原文…", onStop() {} }));
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('<button type="button">停止</button>');
    expect(html.match(/正在整理原文/g)).toHaveLength(1);
    expect(html).not.toContain("progressbar");
  });

  it("does not offer cancellation of a save already sent", () => {
    const html = renderToStaticMarkup(createElement(JournalOperationStatus, { label: "正在保存…" }));
    expect(html).toContain("正在保存…");
    expect(html).not.toContain("<button");
  });
});
