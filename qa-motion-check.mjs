import { chromium } from "playwright-core";

const EMAIL = "mapqa-1787023856@example.test";
const PASSWORD = "map-qa-password-2026";
const ORIGIN = "https://106.53.130.142";

async function signInAndLoad(context, page) {
  await context.request.post(`${ORIGIN}/api/auth/sign-in/email`, {
    data: { email: EMAIL, password: PASSWORD },
  });
  const orgs = await (await context.request.get(`${ORIGIN}/api/auth/organization/list`)).json();
  await context.request.post(`${ORIGIN}/api/auth/organization/set-active`, {
    data: { organizationId: orgs[0].id },
    headers: { origin: ORIGIN },
  });
  await page.goto(`${ORIGIN}/`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(6000);
}

async function main() {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const issues = [];
  page.on("pageerror", (error) => issues.push(error.message));
  page.on("console", (m) => { if (m.type() === "error") issues.push(m.text()); });

  await signInAndLoad(context, page);

  // 1. Shared-Element Morph: click a rail card and sample animations mid-flight.
  const railCard = page.locator(".living-atlas__journey-rail li button").first();
  const hasExistingActive = await page.locator(".living-atlas__active").count() > 0;
  await railCard.click();
  await page.waitForTimeout(80);
  const morphAnimations = await page.evaluate(() =>
    document.getAnimations()
      .filter((a) => a.constructor.name.includes("ViewTransition")
        || (a.constructor.name === "CSSAnimation" && a.animationName?.includes("motionCard")))
      .map((a) => a.constructor.name),
  );
  await page.waitForTimeout(900);
  const activeCard = await page.locator(".living-atlas__active").count();
  console.log(`1. MORPH: existingActiveBefore=${hasExistingActive} midFlightAnimations=${JSON.stringify(morphAnimations)} activeCardAfter=${activeCard}`);

  // 2. Cluster Bloom ring on the active journey stops.
  const ringCount = await page.locator(".particle-earth-route__point-ring").count();
  console.log(`2. BLOOM: point rings=${ringCount}`);

  // 3. Staged UI Assembly in the story dialog.
  await page.locator(".living-atlas__active button", { hasText: "打开故事" }).click();
  await page.waitForTimeout(120);
  const staged = await page.evaluate(() => {
    const article = document.querySelector(".journey-story");
    const children = article ? [...article.children] : [];
    return {
      hasClass: article?.classList.contains("motion-staged") ?? false,
      animations: children.map((child) => {
        const style = getComputedStyle(child);
        return { name: style.animationName, delay: style.animationDelay };
      }),
    };
  });
  console.log("3. STAGED:", JSON.stringify(staged));
  await page.screenshot({ path: "D:\\startrips\\motion-story.png" });

  // 4. Reduced motion: dialog children must have animation none.
  await page.keyboard.press("Escape");
  await page.waitForTimeout(600);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.locator(".living-atlas__active button", { hasText: "打开故事" }).click();
  await page.waitForTimeout(120);
  const reduced = await page.evaluate(() => {
    const article = document.querySelector(".journey-story");
    const children = article ? [...article.children] : [];
    return children.map((child) => getComputedStyle(child).animationName);
  });
  console.log("4. REDUCED:", JSON.stringify(reduced));

  console.log("5. ISSUES:", issues.length ? JSON.stringify(issues.slice(0, 5)) : "(none)");
  await browser.close();
}

main().catch((error) => { console.error("FAILED:", error); process.exit(1); });
