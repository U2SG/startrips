// Reuse the real Stream harness and its baseline journal regression first.
import "./qa-daily-journal.mjs";
import assert from "node:assert/strict";
import { launchQaBrowser } from "./qa-browser.mjs";
const browser = await launchQaBrowser();
const origin = process.env.QA_ORIGIN ?? "http://127.0.0.1:4173";
const journeyId = "11111111-1111-4111-8111-111111111111";
const pointId = "44444444-4444-4444-8444-444444444444";
const source = "23:40 她在虚构城入住星桥酒店。";
const journal = { revision: 1, chapters: [{ id: "chapter-hotel", date: "2027-04-03", title: "住宿", source,
  events: [{ id: "event-hotel", source, text: "她保留的手工正文。", edited: true, status: "uncertain", localDate: "2027-04-03", localTime: "23:40", timeContext: "当地时间", routePointId: null, mediaIds: [] }], suggestions: [] }] };
try {
  for (const width of [1280, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    const page = await context.newPage();
    let previews = 0, writes = 0, releasePreview, releaseApply;
    let stored = structuredClone(journal);
    const errors = []; page.on("pageerror", e => errors.push(e.message));
    await page.route(/\/api\/journeys\/[^/]+\/journal(?:\/hotels\/(?:preview|apply))?$/, async route => {
      const url = route.request().url();
      if (url.endsWith("/preview")) {
        previews++;
        await new Promise(resolve => { releasePreview = resolve; });
        await route.fulfill({ json: { preview: { token: "test-signed-preview", hotels: [{ eventId: "event-hotel", evidence: source, label: "星桥酒店", context: "虚构城", existingPointId: null }], questions: ["取消的山谷酒店未添加。"] } } }).catch(() => {});
      } else if (url.endsWith("/apply")) {
        writes++; assert.deepEqual(route.request().postDataJSON(), { token: "test-signed-preview", confirmed: true });
        await new Promise(resolve => { releaseApply = resolve; });
        const saved = structuredClone(journal); saved.revision = 2; saved.chapters[0].events[0].status = "actual"; saved.chapters[0].events[0].routePointId = pointId;
        stored = saved;
        await route.fulfill({ json: { journal: saved, journey: { id: journeyId, atlasId: "fictional-atlas", title: "虚构旅行手记验收", note: "", startedOn: "2027-04-03", endedOn: null, lightColor: "#74e7d0", revision: 2, createdByUserId: "fictional-owner", createdAt: "2027-04-03T00:00:00Z", updatedAt: "2027-04-03T00:00:00Z", media: [], routePoints: [{ id: pointId, journeyId, sortOrder: 0, latitude: 10, longitude: 20, label: "星桥酒店", isStop: true, occurredAt: null }] } } });
      } else await route.fulfill({ json: { journal: url.includes(journeyId) ? stored : { revision: 0, chapters: [] } } });
    });
    await page.goto(`${origin}/artifacts/daily-journal/index.html`);
    await page.getByRole("button", { name: "每日手记", exact: true }).click();
    const preview = () => page.getByRole("button", { name: "用 AI 查找已入住酒店" });
    await preview().click(); await page.getByText("正在检索酒店…", { exact: true }).waitFor();
    releasePreview(); await page.getByRole("button", { name: "确认批量添加及关联" }).waitFor();
    await page.getByRole("button", { name: "取消酒店预览" }).click(); assert.equal(writes, 0);
    await preview().click(); await page.getByText("正在检索酒店…", { exact: true }).waitFor();
    releasePreview(); const apply = page.getByRole("button", { name: "确认批量添加及关联" }); await apply.waitFor();
    await apply.evaluate(button => { button.click(); button.click(); });
    await page.getByText("正在保存…", { exact: true }).waitFor(); assert.equal(writes, 1);
    assert.equal(await page.getByRole("button", { name: "取消酒店预览" }).isDisabled(), true);
    assert.equal(await page.getByRole("button", { name: "返回 Stream" }).isDisabled(), true);
    await page.keyboard.press("Escape"); assert.equal(await page.getByRole("dialog", { name: "每日手记" }).count(), 1);
    releaseApply(); await page.getByText("酒店地点及手记关联已保存。", { exact: true }).waitFor();
    await page.getByText("她保留的手工正文。", { exact: true }).waitFor();
    await page.screenshot({ path: `artifacts/daily-journal/hotels-${width}.png`, fullPage: true });
    await page.getByRole("button", { name: "在 Stream 中查看地点：星桥酒店" }).click();
    await page.waitForFunction(id => window.__observation?.routePointId === id, pointId);
    await page.getByRole("button", { name: "每日手记", exact: true }).click();
    assert.equal(await page.evaluate(() => window.__ownerJourney.routePoints.some(p => p.id === "44444444-4444-4444-8444-444444444444")), true);
    await page.evaluate(() => window.dispatchEvent(new Event("qa-remount-stream")));
    await page.getByRole("button", { name: "每日手记", exact: true }).click();
    await page.getByRole("button", { name: "在 Stream 中查看地点：星桥酒店" }).waitFor();
    // A late preview must not land in the newly selected account.
    await preview().click(); await page.getByText("正在检索酒店…", { exact: true }).waitFor();
    await page.evaluate(() => window.dispatchEvent(new Event("qa-account-switch")));
    releasePreview(); await page.getByRole("button", { name: "每日手记", exact: true }).click();
    await page.getByText("还没有每日手记。可以先导入文字，无照片和坐标也能保存阅读。", { exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "确认批量添加及关联" }).count(), 0);
    assert.equal(previews, 3); assert.deepEqual(errors, []);
    await context.close();
  }
  console.log("hotel tools Stream regression passed at 1280/390");
} finally { await browser.close(); }
