const { MOBILE_UA } = require("../config");

async function closeInstagramPopups(page) {
  const selectors = [
    "button:has-text('Allow all cookies')",
    "button:has-text('Accept all')",
    "button:has-text('Not Now')",
    "button:has-text('Not now')",
    "button:has-text('Save Info')",
    "button:has-text('Save information')",
    "button:has-text('Turn On')",
    "button:has-text('Turn on')"
  ];

  for (const selector of selectors) {
    try {
      const btn = page.locator(selector).first();

      if (await btn.isVisible({ timeout: 200 }).catch(() => false)) {
        await btn.click({ timeout: 500 });
        await page.waitForTimeout(150);
      }
    } catch {}
  }
}

async function isLoggedIn(page) {
  try {
    return await page.evaluate(() => {
      const text = document.body.innerText || "";

      return Boolean(
        document.querySelector('a[href="/"]') ||
          document.querySelector('a[href="/direct/inbox/"]') ||
          document.querySelector('svg[aria-label="Home"]') ||
          document.querySelector('svg[aria-label="Trang chủ"]') ||
          text.includes("Log out") ||
          text.includes("Đăng xuất")
      );
    });
  } catch {
    return false;
  }
}

async function ensureInstagramLoggedIn(page) {
  await page.goto("https://www.instagram.com/", {
    waitUntil: "domcontentloaded",
    timeout: 60000
  });

  await page.waitForTimeout(2500);
  await closeInstagramPopups(page);

  if (await isLoggedIn(page)) {
    console.log("✅ Instagram session OK");
    return;
  }

  throw new Error(
    "Instagram chưa có session hoặc session đã hết hạn. Mở http://localhost:3000/setup-login rồi login Instagram thủ công một lần."
  );
}

async function switchToHtmlMode(page, igCookie = "") {
  const headers = {
    "user-agent": MOBILE_UA,
    "accept-language": "en-US,en;q=0.9",
    referer: "https://www.instagram.com/",
    "x-ig-app-id": "936619743392459"
  };

  if (igCookie) {
    headers.cookie = igCookie;
  }

  await page.setExtraHTTPHeaders(headers);

  await page.setViewportSize({
    width: 390,
    height: 844
  });
}

async function prepareInstagramApiPage(page, username = "", igCookie = "") {
  await switchToHtmlMode(page, igCookie);

  const target = username
    ? `https://www.instagram.com/${username}/`
    : "https://www.instagram.com/";

  await page.goto(target, {
    waitUntil: "domcontentloaded",
    timeout: 60000
  });

  await page.waitForTimeout(1200);
  await closeInstagramPopups(page);
}

module.exports = {
  closeInstagramPopups,
  isLoggedIn,
  ensureInstagramLoggedIn,
  switchToHtmlMode,
  prepareInstagramApiPage
};