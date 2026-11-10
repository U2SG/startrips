import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { JournalImportControl, JournalImportProgress, countJournalSourceCharacters, journalImportStatusLabel } from "./JournalImportControl";
import { createJournalImportClient } from "./journalImportApi";

describe("journal import controls", () => {
  it("offers only one AI import action without redundant instruction or provider controls", () => {
    const fetcher = vi.fn<typeof fetch>();
    const html = renderToStaticMarkup(createElement(JournalImportControl, {
      client: createJournalImportClient(fetcher),
      input: { journeyId: "synthetic-journey", atlasId: "synthetic-atlas", source: "合成记录", fallbackDate: "2027-04-03" },
      disabled: false, control: { current: null }, onBusy() {}, onPreview() {},
    }));
    expect(html).not.toContain("<input");
    expect(html.match(/<button/g)).toHaveLength(1);
    expect(html).toContain("用 AI 导入");
    expect(html).toContain("不代表事件发生日期");
    expect(html).toContain("2027-04-03");
    expect(html).not.toContain("provider:");
    expect(html).not.toContain("synthetic-atlas");
    expect(html).not.toContain("disabled");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("truthfully disables import when the AI client is unavailable", () => {
    const html = renderToStaticMarkup(createElement(JournalImportControl, {
      input: { journeyId: "fixture", atlasId: "fixture", source: "原文", fallbackDate: "2027-04-03" },
      disabled: false, control: { current: null }, onBusy() {}, onPreview() {},
    }));
    expect(html).toContain("AI 导入暂不可用"); expect(html).toContain("disabled");
    expect(html).not.toContain("已填入预览");
  });
  it("shows phases instead of generation counters without an invented percentage", () => {
    expect(journalImportStatusLabel({ status: "observing", progress: { phase: "receiving", characters: 1250, chunks: 12 } })).toBe("正在接收识别结果…");
    expect(journalImportStatusLabel({ status: "observing", progress: { phase: "validating", characters: 1250, chunks: 12 } })).toBe("正在处理 · 核对完整记录…");
    expect(journalImportStatusLabel({ status: "stopping" })).toBe("正在停止…");
    expect(journalImportStatusLabel({ status: "completed" })).toBe("识别完成，已填入预览，尚未保存。");
  });
  it("counts source graphemes locally, excluding whitespace but retaining punctuation", () => {
    expect(countJournalSourceCharacters(" \t\n")).toBe(0);
    expect(countJournalSourceCharacters("旅行 A😀 e\u0301 👨‍👩‍👧‍👦！")).toBe(7);
    expect(countJournalSourceCharacters("👍🏽 🇨🇳")).toBe(2);
    expect(countJournalSourceCharacters("中😀".repeat(50_000))).toBe(100_000);
  });
  it.each([0, 40_000, Number.MAX_SAFE_INTEGER])("never turns output size %s into a percentage or source count", characters => {
    const html = renderToStaticMarkup(createElement(JournalImportProgress, {
      state: {status: "observing", progress: {phase: "receiving", characters, chunks: 12}}, onStop() {}, onResume() {},
    }));
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('role="status"');
    expect(html).not.toContain("aria-valuenow");
    expect(html).not.toContain("%");
    expect(html).not.toContain(" 字");
    expect(html).toContain("正在接收识别结果");
  });
  it.each([
    ["queued", "正在等待处理"], ["connecting", "正在连接模型"], ["validating", "正在处理"],
  ] as const)("labels the %s phase", (phase, label) => {
    expect(journalImportStatusLabel({ status: "observing", progress: { phase, characters: 0, chunks: 0 } })).toContain(label);
  });
  it.each(["paused", "failed", "cancelled", "completed"] as const)("does not animate a %s task", status => {
    const html = renderToStaticMarkup(createElement(JournalImportProgress, {state: {status, message: "状态详情"}, onStop() {}, onResume() {}}));
    expect(html).not.toContain('role="progressbar"');
    expect(html).toContain(journalImportStatusLabel({status}));
    expect(html.includes("继续接收</button>")).toBe(status === "paused");
    expect(html.includes('role="alert"')).toBe(status === "paused" || status === "failed");
  });
  it("keeps stop confirmation distinct from a paused observer", () => {
    const render = (status: "paused" | "stopping") => renderToStaticMarkup(createElement(JournalImportProgress, {state: {status, stopping: true}, onStop() {}, onResume() {}}));
    expect(render("paused")).toContain("停止尚未确认");
    expect(render("paused")).toContain("重试停止</button>");
    expect(render("paused")).not.toContain("继续接收</button>");
    expect(render("stopping")).not.toContain("<button");
  });
});
