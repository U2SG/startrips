import { chromium } from "playwright-core";

async function main() {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const issues = [];
  page.on("pageerror", (error) => issues.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") issues.push(message.text());
  });

  await page.goto("https://lbs.qq.com/dev/console/custom/apply", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });
  await page.waitForTimeout(8000);

  const url = page.url();
  const title = await page.title();
  console.log("=== PAGE ===");
  console.log(`url: ${url}`);
  console.log(`title: ${title}`);

  const text = await page.evaluate(() =>
    (document.body?.innerText ?? "").replace(/\n{2,}/g, "\n").slice(0, 3000));
  console.log("=== VISIBLE TEXT ===");
  console.log(text || "(empty)");

  // Try to capture selectable options / checkboxes / links mentioning services.
  const options = await page.evaluate(() => {
    const collect = (selector) =>
      [...document.querySelectorAll(selector)]
        .map((el) => (el.textContent ?? el.getAttribute("title") ?? "").trim())
        .filter(Boolean)
        .slice(0, 40);
    return {
      radio: collect('input[type="radio"] + *, [class*="radio"] label'),
      checkbox: collect('input[type="checkbox"] + *'),
      links: collect("a"),
      buttons: collect("button"),
    };
  });
  console.log("=== CONTROLS ===");
  console.log(JSON.stringify(options, null, 2).slice(0, 3000));

  await page.screenshot({ path: "D:\\startrips\\lbs-custom-apply.png", fullPage: true });
  console.log("=== ISSUES ===");
  issues.slice(0, 10).forEach((line) => console.log(line));
  if (issues.length === 0) console.log("(none)");
  await browser.close();
}

main().catch((error) => {
  console.error("FAILED:", error);
  process.exit(1);
});
