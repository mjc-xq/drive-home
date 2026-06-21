const { chromium } = require("playwright");

async function waitUnity(page) {
  await page.waitForSelector("canvas", { timeout: 30000 });
  await page.waitForFunction(() => {
    const loader = document.querySelector("#unity-loading-bar");
    return !loader || getComputedStyle(loader).display === "none";
  }, { timeout: 120000 });
  await page.waitForTimeout(9000);
}

async function launchContext(viewport, opts = {}) {
  const browser = await chromium.launch({
    headless: true,
    executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  });
  const context = await browser.newContext({ viewport, ...opts });
  const page = await context.newPage();
  const logs = [];
  page.on("console", (msg) => logs.push({ type: msg.type(), text: msg.text() }));
  page.on("pageerror", (err) => logs.push({ type: "pageerror", text: err.message }));
  return { browser, page, logs };
}

(async () => {
  const version = Date.now();
  const desktop = await launchContext({ width: 1280, height: 720 });
  await desktop.page.goto(`http://127.0.0.1:4173/?verify=${version}`, { waitUntil: "domcontentloaded", timeout: 60000 });
  const link = desktop.page.locator("a[href='/unity/da-hilg/index.html']");
  if (await link.count() !== 1) throw new Error("Unity launcher link missing or duplicated");
  await Promise.all([
    desktop.page.waitForURL(/\/unity\/da-hilg\/index\.html/, { timeout: 60000 }),
    link.click(),
  ]);
  await waitUnity(desktop.page);
  await desktop.page.screenshot({ path: "/tmp/dahilg-unity-desktop-fixed.png" });
  await desktop.page.mouse.click(1216, 40);
  await desktop.page.waitForTimeout(800);
  await desktop.page.screenshot({ path: "/tmp/dahilg-unity-actions-fixed.png" });
  await desktop.page.mouse.click(1130, 40);
  await desktop.page.waitForTimeout(800);
  await desktop.page.screenshot({ path: "/tmp/dahilg-unity-level-fixed.png" });
  const desktopState = await desktop.page.evaluate(() => {
    const canvas = document.querySelector("canvas");
    return {
      url: location.href,
      title: document.title,
      canvas: canvas ? { width: canvas.width, height: canvas.height, cssWidth: canvas.clientWidth, cssHeight: canvas.clientHeight } : null,
    };
  });
  await desktop.browser.close();

  const mobile = await launchContext({ width: 844, height: 390 }, { isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await mobile.page.goto(`http://127.0.0.1:4173/unity/da-hilg/index.html?verify=${version}`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await waitUnity(mobile.page);
  await mobile.page.screenshot({ path: "/tmp/dahilg-unity-mobile-fixed.png" });
  await mobile.page.touchscreen.tap(790, 40);
  await mobile.page.waitForTimeout(800);
  await mobile.page.screenshot({ path: "/tmp/dahilg-unity-mobile-actions-fixed.png" });
  await mobile.page.touchscreen.tap(700, 40);
  await mobile.page.waitForTimeout(800);
  await mobile.page.screenshot({ path: "/tmp/dahilg-unity-mobile-level-fixed.png" });
  const mobileState = await mobile.page.evaluate(() => {
    const canvas = document.querySelector("canvas");
    return {
      url: location.href,
      title: document.title,
      canvas: canvas ? { width: canvas.width, height: canvas.height, cssWidth: canvas.clientWidth, cssHeight: canvas.clientHeight } : null,
    };
  });
  await mobile.browser.close();

  const errorLogs = [...desktop.logs, ...mobile.logs].filter((log) => log.type === "error" || log.type === "pageerror");
  console.log(JSON.stringify({
    desktopState,
    mobileState,
    errorLogs: errorLogs.slice(0, 20),
    desktopLogTail: desktop.logs.slice(-12),
    mobileLogTail: mobile.logs.slice(-12),
  }, null, 2));
})();
