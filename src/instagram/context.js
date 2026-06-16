const { chromium } = require("playwright");

const { IG_SESSION_DIR, HEADLESS, DESKTOP_UA } = require("../config");
const { cookieStringToPlaywrightCookies } = require("../utils/cookie");
const { getSessionStatus, setSessionStatus } = require("./state");

let igContext = null;

async function createDefaultInstagramContext() {
  return await chromium.launchPersistentContext(IG_SESSION_DIR, {
    headless: HEADLESS,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled",
      "--disable-features=PasswordManagerOnboarding,PasswordLeakDetection",
      "--disable-save-password-bubble"
    ],
    userAgent: DESKTOP_UA,
    viewport: {
      width: 1280,
      height: 900
    },
    locale: "en-US"
  });
}

async function getInstagramContext() {
  if (!igContext) {
    igContext = await createDefaultInstagramContext();

    igContext.on("close", () => {
      console.log("⚠️ Instagram default context closed");
      igContext = null;

      setSessionStatus({
        ok: false,
        lastCheckedAt: getSessionStatus().lastCheckedAt,
        lastError: "Instagram context closed"
      });
    });

    console.log("✅ Instagram default context created");
  }

  return igContext;
}

async function createPrivateCookieContext(igCookie) {
  const browser = await chromium.launch({
    headless: HEADLESS,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled",
      "--disable-features=PasswordManagerOnboarding,PasswordLeakDetection",
      "--disable-save-password-bubble"
    ]
  });

  const context = await browser.newContext({
    userAgent: DESKTOP_UA,
    viewport: {
      width: 1280,
      height: 900
    },
    locale: "en-US"
  });

  const cookies = cookieStringToPlaywrightCookies(igCookie);

  if (cookies.length === 0) {
    await browser.close().catch(() => {});
    throw new Error("Private cookie rỗng hoặc không hợp lệ");
  }

  await context.addCookies(cookies);

  console.log(`✅ Private cookie context created | cookies=${cookies.length}`);

  return {
    browser,
    context
  };
}

async function closeDefaultInstagramContext() {
  if (igContext) {
    await igContext.close().catch(() => {});
    igContext = null;
  }
}

module.exports = {
  getInstagramContext,
  createDefaultInstagramContext,
  createPrivateCookieContext,
  closeDefaultInstagramContext
};