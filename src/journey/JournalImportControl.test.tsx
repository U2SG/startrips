import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { JournalImportControl, journalImportStatusLabel } from "./JournalImportControl";
import { createJournalImportClient } from "./journalImportApi";

describe("journal import controls", () => {
  it("offers the scoped sentence and one import action without displaying provider details", () => {
    const fetcher = vi.fn<typeof fetch>();
    const html = renderToStaticMarkup(createElement(JournalImportControl, {
      client: createJournalImportClient(fetcher),
      input: { journeyId: "synthetic-journey", atlasId: "synthetic-atlas", source: "合成记录", fallbackDate: "2027-04-03" },
      disabled: false, control: { current: null }, onBusy() {}, onPreview() {},
    }));
    expect(html).toContain('aria-label="一句话导入要求"');
    expect(html.match(/<button/g)).toHaveLength(1);
    expect(html).toContain("用 AI 导入");
    expect(html).not.toContain("provider:");
    expect(html).not.toContain("synthetic-atlas");
    expect(html).not.toContain("disabled");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("shows actual generation counters and validation phase without an invented percentage", () => {
    expect(journalImportStatusLabel({ status: "observing", progress: { phase: "receiving", characters: 1250, chunks: 12 } })).toBe("正在接收 · 1,250 字");
    expect(journalImportStatusLabel({ status: "observing", progress: { phase: "validating", characters: 1250, chunks: 12 } })).toBe("正在核对完整记录…");
    expect(journalImportStatusLabel({ status: "stopping" })).toBe("正在停止…");
  });
});
