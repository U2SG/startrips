import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  JourneyRecordedTracks,
  journeyRecordedTrackErrorMessage,
  runJourneyRecordedTrackScopedRequest,
  type JourneyRecordedTrackRequestScope,
} from "./JourneyRecordedTracks";
import { JourneyRecordedTrackApiError } from "./journeyRecordedTracksApi";

describe("JourneyRecordedTracks", () => {
  it("renders a bounded saved-Journey import surface without precise samples", () => {
    const markup = renderToStaticMarkup(createElement(JourneyRecordedTracks, { journeyId: "journey-1" }));
    expect(markup).toContain("记录轨迹");
    expect(markup).toContain('type="file"');
    expect(markup).toContain("导入这份 GPX");
    expect(markup).toContain("不会自动生成 Route Point");
    expect(markup).not.toMatch(/latitude|longitude|operationKey/);
  });

  it.each([
    [400, "UNSUPPORTED_FORMAT", "wpt"],
    [400, "MALFORMED_FILE", "无法完整读取"],
    [413, "FILE_TOO_LARGE", "大小限制"],
    [413, "REQUEST_TOO_LARGE", "大小限制"],
    [409, "RECORDED_TRACK_CONFLICT", "冲突"],
    [404, "JOURNEY_NOT_FOUND", "失去访问权限"],
    [401, "UNAUTHORIZED", "没有管理"],
    [403, "FORBIDDEN", "没有管理"],
  ])("maps %s/%s to distinct recoverable copy", (status, code, copy) => {
    const message = journeyRecordedTrackErrorMessage(
      new JourneyRecordedTrackApiError(status, code, code),
      "import",
    );
    expect(message).toContain(copy);
  });

  it("keeps transport uncertainty explicitly unknown and retryable", () => {
    const message = journeyRecordedTrackErrorMessage(new TypeError("network"), "import");
    expect(message).toContain("结果暂时无法确认");
    expect(message).toContain("安全重试");
    expect(message).not.toContain("导入成功");
    expect(message).not.toContain("没有写入");
  });

  it("drops late import and withdrawal completions after Journey switch or editor close", async () => {
    const deferred = <T,>() => {
      let resolve!: (value: T | PromiseLike<T>) => void;
      const promise = new Promise<T>((settle) => { resolve = settle; });
      return { promise, resolve };
    };

    let active: JourneyRecordedTrackRequestScope = { journeyId: "journey-a", revision: 7 };
    const importScope = active;
    const importResponse = deferred<{ replayed: boolean }>();
    const importCommit = vi.fn();
    const importRequest = runJourneyRecordedTrackScopedRequest(
      importScope,
      () => active,
      () => importResponse.promise,
      importCommit,
    );
    active = { journeyId: "journey-b", revision: 8 };
    importResponse.resolve({ replayed: false });
    await expect(importRequest).resolves.toBe(false);
    expect(importCommit).not.toHaveBeenCalled();

    const withdrawalScope = active;
    const withdrawalResponse = deferred<void>();
    const withdrawalCommit = vi.fn();
    const withdrawalRequest = runJourneyRecordedTrackScopedRequest(
      withdrawalScope,
      () => active,
      () => withdrawalResponse.promise,
      withdrawalCommit,
    );
    active = { journeyId: null, revision: 9 };
    withdrawalResponse.resolve();
    await expect(withdrawalRequest).resolves.toBe(false);
    expect(withdrawalCommit).not.toHaveBeenCalled();
  });

  it("contains an explicit two-step withdrawal confirmation and no persistence/logging escape hatch", () => {
    const component = readFileSync(new URL("JourneyRecordedTracks.tsx", import.meta.url), "utf8");
    const api = readFileSync(new URL("journeyRecordedTracksApi.ts", import.meta.url), "utf8");
    expect(component).toContain("撤回此记录");
    expect(component).toContain("确认撤回");
    expect(component).toContain('role="alertdialog"');
    for (const source of [component, api]) {
      expect(source).not.toMatch(/localStorage|sessionStorage|console\.(?:log|info|debug|warn|error)/);
    }
    expect(api).toContain("body: JSON.stringify({ operationKey })");
    expect(api).not.toContain("?operationKey=");
  });
});
