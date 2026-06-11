require("dotenv").config();

const express = require("express");
const cors = require("cors");
const { chromium } = require("playwright");
const { nanoid } = require("nanoid");
const nodemailer = require("nodemailer");

const app = express();

app.use(cors());
app.use(express.json({ limit: "1mb" }));

const IG_SESSION_DIR = "./ig-session";
const HEADLESS = true;

const DESKTOP_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

const MOBILE_UA =
  "Mozilla/5.0 (Linux; Android 10; Pixel 5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36";

let igContext = null;

let sessionStatus = {
  ok: false,
  lastCheckedAt: null,
  lastError: null
};

let sessionCheckRunning = false;
let lastAlertSentAt = 0;

const SESSION_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 tiếng
const SESSION_CHECK_MAX_ATTEMPTS = 3;
const SESSION_CHECK_RETRY_DELAY_MS = 10 * 1000; // 10 giây
const ALERT_COOLDOWN_MS = 6 * 60 * 60 * 1000; // tránh spam email

const PRIVATE_COOKIE_HEADER = "x-ig-cookie";

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizeIgCookie(cookie) {
  return String(cookie || "").trim();
}

function getIgCookieFromReq(req) {
  return normalizeIgCookie(
    req.headers[PRIVATE_COOKIE_HEADER] ||
      req.body?.igCookie ||
      req.body?.privateCookie ||
      ""
  );
}

function parseCookieString(cookieString) {
  const ignoredNames = new Set([
    "path",
    "domain",
    "expires",
    "max-age",
    "secure",
    "httponly",
    "samesite"
  ]);

  return String(cookieString || "")
    .split(";")
    .map(part => part.trim())
    .filter(Boolean)
    .map(part => {
      const eqIndex = part.indexOf("=");

      if (eqIndex === -1) return null;

      const name = part.slice(0, eqIndex).trim();
      const value = part.slice(eqIndex + 1).trim();

      if (!name || ignoredNames.has(name.toLowerCase())) {
        return null;
      }

      return {
        name,
        value
      };
    })
    .filter(Boolean);
}

function cookieStringToPlaywrightCookies(cookieString) {
  const pairs = parseCookieString(cookieString);

  return pairs.map(cookie => ({
    name: cookie.name,
    value: cookie.value,
    domain: ".instagram.com",
    path: "/",
    secure: true
  }));
}

async function getInstagramContext() {
  if (!igContext) {
    igContext = await createDefaultInstagramContext();

    igContext.on("close", () => {
      console.log("⚠️ Instagram default context closed");
      igContext = null;
      sessionStatus = {
        ok: false,
        lastCheckedAt: sessionStatus.lastCheckedAt,
        lastError: "Instagram context closed"
      };
    });

    console.log("✅ Instagram default context created");
  }

  return igContext;
}

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

async function sendSessionAlertEmail(errorMessage) {
  const now = Date.now();

  if (now - lastAlertSentAt < ALERT_COOLDOWN_MS) {
    console.log("⚠️ Đã gửi alert gần đây, bỏ qua để tránh spam email");
    return;
  }

  const {
    SMTP_HOST,
    SMTP_PORT,
    SMTP_SECURE,
    SMTP_USER,
    SMTP_PASS,
    ALERT_EMAIL_TO
  } = process.env;

  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS || !ALERT_EMAIL_TO) {
    console.log("⚠️ Thiếu SMTP config trong .env, không gửi được email alert");
    return;
  }

  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT || 587),
    secure: String(SMTP_SECURE || "false") === "true",
    auth: {
      user: SMTP_USER,
      pass: SMTP_PASS
    }
  });

  await transporter.sendMail({
    from: `"Instagram Downloader Server" <${SMTP_USER}>`,
    to: ALERT_EMAIL_TO,
    subject: "⚠️ Instagram default session lỗi hoặc hết hạn",
    text: [
      "Instagram default session checker đã thử tối đa 3 lần nhưng vẫn thất bại.",
      "",
      `Thời gian: ${new Date().toISOString()}`,
      `Lỗi: ${errorMessage}`,
      "",
      "Cần mở /setup-login để đăng nhập Instagram clone/default lại."
    ].join("\n")
  });

  lastAlertSentAt = now;
  console.log("📧 Đã gửi email cảnh báo default session Instagram lỗi");
}

async function checkInstagramSessionWithRetry(reason = "manual", alertOnFail = false) {
  if (sessionCheckRunning) {
    console.log("⏳ Default session check đang chạy, bỏ qua lần gọi mới");
    return sessionStatus.ok;
  }

  sessionCheckRunning = true;

  try {
    let lastError = null;

    for (let attempt = 1; attempt <= SESSION_CHECK_MAX_ATTEMPTS; attempt++) {
      let page = null;

      try {
        console.log(
          `🔍 Check default Instagram session lần ${attempt}/${SESSION_CHECK_MAX_ATTEMPTS} | reason=${reason}`
        );

        const context = await getInstagramContext();
        page = await context.newPage();

        await ensureInstagramLoggedIn(page);

        sessionStatus = {
          ok: true,
          lastCheckedAt: new Date().toISOString(),
          lastError: null
        };

        console.log("✅ Default Instagram session OK");
        return true;
      } catch (err) {
        lastError = err;

        console.log(
          `❌ Check default Instagram session fail lần ${attempt}/${SESSION_CHECK_MAX_ATTEMPTS}:`,
          err.message
        );

        if (attempt < SESSION_CHECK_MAX_ATTEMPTS) {
          await sleep(SESSION_CHECK_RETRY_DELAY_MS);
        }
      } finally {
        if (page) {
          await page.close().catch(() => {});
        }
      }
    }

    sessionStatus = {
      ok: false,
      lastCheckedAt: new Date().toISOString(),
      lastError: lastError?.message || "Unknown error"
    };

    if (alertOnFail) {
      try {
        await sendSessionAlertEmail(sessionStatus.lastError);
      } catch (emailErr) {
        console.log("❌ Không gửi được email alert:", emailErr.message);
      }
    }

    return false;
  } finally {
    sessionCheckRunning = false;
  }
}

async function startInstagramSessionWatcher() {
  checkInstagramSessionWithRetry("server-start", true).catch(err => {
    console.log("❌ Startup default session check crashed:", err.message);
  });

  setInterval(() => {
    checkInstagramSessionWithRetry("scheduled-6h", true).catch(err => {
      console.log("❌ Scheduled default session check crashed:", err.message);
    });
  }, SESSION_CHECK_INTERVAL_MS);
}

function isInstagramUrl(url) {
  try {
    const u = new URL(url);
    return (
      u.hostname === "instagram.com" ||
      u.hostname === "www.instagram.com" ||
      u.hostname.endsWith(".instagram.com")
    );
  } catch {
    return false;
  }
}

function isInstagramStoryUrl(url) {
  try {
    const u = new URL(url);
    const first = u.pathname.split("/").filter(Boolean)[0];

    // /stories/user/storyPk = story thường
    // /s/... = tin nổi bật / highlight / story share dạng mới
    return first === "stories" || first === "s";
  } catch {
    return false;
  }
}

function isInstagramHighlightStoryUrl(url) {
  try {
    const u = new URL(url);
    const first = u.pathname.split("/").filter(Boolean)[0];

    return first === "s";
  } catch {
    return false;
  }
}

function getInstagramShortcode(url) {
  try {
    const u = new URL(url);
    const parts = u.pathname.split("/").filter(Boolean);
    const type = parts[0];
    const code = parts[1];

    if (["p", "reel", "tv"].includes(type) && code) {
      return code;
    }

    return "";
  } catch {
    return "";
  }
}

function getInstagramStoryPk(url) {
  try {
    const u = new URL(url);
    const parts = u.pathname.split("/").filter(Boolean);

    if (parts[0] === "stories" && parts[2]) {
      return parts[2];
    }

    if (parts[0] === "s") {
      return (
        u.searchParams.get("story_media_id") ||
        u.searchParams.get("media_id") ||
        u.searchParams.get("id") ||
        parts[1] ||
        ""
      );
    }

    return "";
  } catch {
    return "";
  }
}

function cleanIgUrl(url) {
  return String(url || "")
    .replaceAll("\\/", "/")
    .replaceAll("\\u0026", "&")
    .replaceAll("&amp;", "&");
}

function pickBestImage(candidates = []) {
  return candidates
    .filter(x => x && x.url)
    .map(x => ({
      ...x,
      url: cleanIgUrl(x.url)
    }))
    .sort((a, b) => {
      const areaA = Number(a.width || 0) * Number(a.height || 0);
      const areaB = Number(b.width || 0) * Number(b.height || 0);
      return areaB - areaA;
    })[0];
}

function pickBestVideo(videoVersions = []) {
  return videoVersions
    .filter(x => x && x.url)
    .map(x => ({
      ...x,
      url: cleanIgUrl(x.url)
    }))
    .sort((a, b) => {
      const areaA = Number(a.width || 0) * Number(a.height || 0);
      const areaB = Number(b.width || 0) * Number(b.height || 0);
      return areaB - areaA;
    })[0];
}

function isRealPostImageUrl(url) {
  if (!url) return false;
  if (!url.includes("fbcdn.net")) return false;
  if (url.includes("/t51.82787-19/")) return false;
  if (url.includes("profile_pic")) return false;

  return (
    url.includes(".jpg") ||
    url.includes(".jpeg") ||
    url.includes("dst-jpg") ||
    url.includes("dst-jpegr")
  );
}

function getBestThumbnailUrl(item) {
  const candidates = item?.image_versions2?.candidates || [];

  const bestReal = pickBestImage(
    candidates.filter(c => isRealPostImageUrl(cleanIgUrl(c.url)))
  );

  if (bestReal?.url) {
    return bestReal.url;
  }

  const bestAny = pickBestImage(candidates);

  return bestAny?.url || null;
}

function extractJsonObjectAt(text, startIndex) {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = startIndex; i < text.length; i++) {
    const ch = text[i];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (ch === "\\") {
      escaped = true;
      continue;
    }

    if (ch === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (ch === "{") depth++;
    if (ch === "}") depth--;

    if (depth === 0) {
      return text.substring(startIndex, i + 1);
    }
  }

  return "";
}

function hasMediaShape(obj) {
  return Boolean(
    obj &&
      (
        obj.image_versions2 ||
        obj.video_versions ||
        Array.isArray(obj.carousel_media)
      )
  );
}

function findMediaObjectByShortcode(html, shortcode) {
  const codePos = html.indexOf(`"code":"${shortcode}"`);

  if (codePos === -1) {
    return null;
  }

  for (let i = codePos; i >= Math.max(0, codePos - 30000); i--) {
    if (html[i] !== "{") continue;

    const objectText = extractJsonObjectAt(html, i);
    if (!objectText) continue;

    try {
      const obj = JSON.parse(objectText);

      if (obj && obj.code === shortcode && hasMediaShape(obj)) {
        return obj;
      }
    } catch {}
  }

  return null;
}

function findStoryObjectByPk(html, storyPk) {
  let pkPos = html.indexOf(`"pk":"${storyPk}"`);

  if (pkPos === -1 && /^\d+$/.test(String(storyPk))) {
    pkPos = html.indexOf(`"pk":${storyPk}`);
  }

  if (pkPos === -1) {
    return null;
  }

  for (let i = pkPos; i >= Math.max(0, pkPos - 30000); i--) {
    if (html[i] !== "{") continue;

    const objectText = extractJsonObjectAt(html, i);
    if (!objectText) continue;

    try {
      const obj = JSON.parse(objectText);

      if (
        obj &&
        String(obj.pk) === String(storyPk) &&
        hasMediaShape(obj)
      ) {
        return obj;
      }
    } catch {}
  }

  return null;
}

function findFirstMediaObject(html) {
  const needles = [
    '"video_versions"',
    '"image_versions2"',
    '"carousel_media"'
  ];

  const positions = [];

  for (const needle of needles) {
    let pos = html.indexOf(needle);

    while (pos !== -1) {
      positions.push(pos);
      pos = html.indexOf(needle, pos + needle.length);
    }
  }

  positions.sort((a, b) => a - b);

  const seen = new Set();

  for (const pos of positions) {
    for (let i = pos; i >= Math.max(0, pos - 30000); i--) {
      if (html[i] !== "{") continue;

      const objectText = extractJsonObjectAt(html, i);
      if (!objectText || seen.has(objectText)) continue;

      seen.add(objectText);

      try {
        const obj = JSON.parse(objectText);

        if (obj && hasMediaShape(obj)) {
          return obj;
        }
      } catch {}
    }
  }

  return null;
}

function imageItemToOutput(item) {
  const thumbnailUrl = getBestThumbnailUrl(item);

  if (!thumbnailUrl) return null;

  return {
    type: "image",
    width: item.original_width || null,
    height: item.original_height || null,
    duration: null,
    downloadUrl: thumbnailUrl,
    thumbnailUrl: thumbnailUrl
  };
}

function mediaItemToOutput(item) {
  if (!item) return null;

  if (item.media_type === 2 || Array.isArray(item.video_versions)) {
    const best = pickBestVideo(item.video_versions || []);
    const thumbnailUrl = getBestThumbnailUrl(item);

    if (best?.url) {
      return {
        type: "video",
        width: best.width || item.original_width || null,
        height: best.height || item.original_height || null,
        duration: item.video_duration || item.duration || null,
        downloadUrl: best.url,
        thumbnailUrl: thumbnailUrl
      };
    }
  }

  return imageItemToOutput(item);
}

async function extractMediaFromHtml(page, igUrl) {
  const html = await page.content();

  const isStoryLike = isInstagramStoryUrl(igUrl);
  const isHighlightStory = isInstagramHighlightStoryUrl(igUrl);

  let media = null;

  if (isStoryLike) {
    const storyPk = getInstagramStoryPk(igUrl);

    if (storyPk) {
      media = findStoryObjectByPk(html, storyPk);
    }

    if (!media && isHighlightStory) {
      console.log("HTML FALLBACK: /s/ story, scan first media object");
      media = findFirstMediaObject(html);
    }
  } else {
    media = findMediaObjectByShortcode(html, getInstagramShortcode(igUrl));
  }

  if (!media) {
    console.log("HTML MISS: media object not found");
    return [];
  }

  const output = [];

  if (Array.isArray(media.carousel_media) && media.carousel_media.length > 0) {
    for (const item of media.carousel_media) {
      const mediaOut = mediaItemToOutput(item);
      if (mediaOut) output.push(mediaOut);
    }
  } else {
    const mediaOut = mediaItemToOutput(media);
    if (mediaOut) output.push(mediaOut);
  }

  const unique = [
    ...new Map(output.map(item => [item.downloadUrl, item])).values()
  ];

  console.log("HTML HIT media:", unique.length);

  if (unique.length > 0) {
    return unique;
  }

  const ogImage = await page
    .locator('meta[property="og:image"]')
    .getAttribute("content")
    .catch(() => null);

  if (ogImage) {
    const cleanImage = cleanIgUrl(ogImage);

    return [
      {
        type: "image",
        width: null,
        height: null,
        duration: null,
        downloadUrl: cleanImage,
        thumbnailUrl: cleanImage
      }
    ];
  }

  return [];
}

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

async function resolveByHtml(page, igUrl, igCookie = "") {
  await switchToHtmlMode(page, igCookie);

  await page.goto(igUrl, {
    waitUntil: "domcontentloaded",
    timeout: 60000
  });

  await page.waitForTimeout(1200);
  await closeInstagramPopups(page);

  let media = await extractMediaFromHtml(page, igUrl);

  if (media.length > 0) {
    return media;
  }

  try {
    await page.evaluate(() => window.scrollBy(0, 700));
  } catch {}

  await page.waitForTimeout(700);

  media = await extractMediaFromHtml(page, igUrl);

  if (media.length > 0) {
    return media;
  }

  await page.reload({
    waitUntil: "domcontentloaded",
    timeout: 60000
  });

  await page.waitForTimeout(1500);
  await closeInstagramPopups(page);

  media = await extractMediaFromHtml(page, igUrl);

  return media;
}

async function extractInstagramMedia(igUrl, options = {}) {
  const igCookie = normalizeIgCookie(options.igCookie || "");
  const privateMode = Boolean(igCookie);

  if (!isInstagramUrl(igUrl)) {
    throw new Error("URL không phải Instagram");
  }

  const isStory = isInstagramStoryUrl(igUrl);
  const mediaKey = isStory
    ? getInstagramStoryPk(igUrl)
    : getInstagramShortcode(igUrl);

  if (!mediaKey) {
    throw new Error("Không lấy được mã media từ URL Instagram");
  }

  let page = null;
  let privateBrowser = null;
  let context = null;

  try {
    if (privateMode) {
      const privateContextBundle = await createPrivateCookieContext(igCookie);

      privateBrowser = privateContextBundle.browser;
      context = privateContextBundle.context;
    } else {
      if (!sessionStatus.ok) {
        const ok = await checkInstagramSessionWithRetry("resolve-auto-check", false);

        if (!ok) {
          throw new Error(
            "Default Instagram session chưa đăng nhập hoặc đã hết hạn. Mở /setup-login để login lại."
          );
        }
      }

      context = await getInstagramContext();
    }

    page = await context.newPage();

    const postMedia = await resolveByHtml(page, igUrl, igCookie);

    const uniquePostMedia = [
      ...new Map(postMedia.map(item => [item.downloadUrl, item])).values()
    ];

    if (uniquePostMedia.length === 0) {
      throw new Error(
        privateMode
          ? "Không bắt được media. Có thể cookie private hết hạn hoặc account không có quyền xem link này."
          : "Không bắt được media từ HTML Instagram. Có thể link private/expired hoặc default session không có quyền xem."
      );
    }

    const media = uniquePostMedia.map((item, i) => ({
      id: i + 1,
      type: item.type || "image",
      width: item.width || null,
      height: item.height || null,
      duration: item.duration || null,
      downloadUrl: item.downloadUrl,
      thumbnailUrl:
        item.thumbnailUrl ||
        (item.type === "image" ? item.downloadUrl : null)
    }));

    const type =
      media.some(x => x.type === "video")
        ? media.length > 1
          ? "carousel"
          : "video"
        : media.length > 1
          ? "carousel"
          : "image";

    return {
      success: true,
      type,
      total: media.length,
      source: igUrl,
      mediaKey,
      mode: privateMode ? "private-client-cookie" : "public-default-session",
      media
    };
  } finally {
    if (page) {
      await page.close().catch(() => {});
    }

    if (privateBrowser) {
      await privateBrowser.close().catch(() => {});
    }
  }
}

app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "Instagram Downloader API chạy ngon 😎",
    mode: "client-cookie-private-mode",
    publicMode: {
      description: "Không gửi cookie, server dùng default session trong ./ig-session",
      setupLogin: "http://localhost:3000/setup-login",
      sessionStatus: "http://localhost:3000/session-status",
      checkSession: "http://localhost:3000/check-session"
    },
    privateMode: {
      description:
        "Client tự login Instagram bằng WebView, lấy cookie rồi gửi cookie lên server cho từng request. Server không lưu private session.",
      resolve: {
        method: "POST",
        url: "http://localhost:3000/resolve",
        body: {
          url: "instagram_url_here",
          igCookie: "sessionid=...; ds_user_id=...; csrftoken=..."
        },
        headerAlternative: {
          "x-ig-cookie": "sessionid=...; ds_user_id=...; csrftoken=..."
        }
      },
      download: {
        method: "GET",
        url: "http://localhost:3000/download?url=media_url",
        requiredHeaderWhenPrivate: {
          "x-ig-cookie": "sessionid=...; ds_user_id=...; csrftoken=..."
        }
      }
    }
  });
});

app.get("/setup-login", async (req, res) => {
  try {
    if (HEADLESS) {
      return res
        .status(400)
        .send(
          "HEADLESS đang true. Đổi const HEADLESS = false rồi chạy lại server để login default/clone thủ công."
        );
    }

    const context = await getInstagramContext();
    const page = await context.newPage();

    await page.goto("https://www.instagram.com/accounts/login/", {
      waitUntil: "domcontentloaded",
      timeout: 60000
    });

    res.send(`
      <h2>Chrome Playwright đã mở.</h2>
      <p>Đây chỉ là login cho <b>default/clone session</b> của server.</p>
      <p>Private user login phải làm ở client WebView, không login trên server.</p>
      <p>Sau khi vào được Home/feed Instagram là default session đã lưu trong <b>./ig-session</b>.</p>
    `);
  } catch (err) {
    res.status(500).send(err.message);
  }
});

app.get("/session-status", (req, res) => {
  res.json({
    success: true,
    instagramSession: sessionStatus
  });
});

app.get("/check-session", async (req, res) => {
  const ok = await checkInstagramSessionWithRetry("manual-api", false);

  res.status(ok ? 200 : 500).json({
    success: ok,
    instagramSession: sessionStatus
  });
});

app.post("/resolve", async (req, res) => {
  try {
    const { url } = req.body;
    const igCookie = getIgCookieFromReq(req);

    if (!url) {
      return res.status(400).json({
        success: false,
        error: "Thiếu url"
      });
    }

    const data = await extractInstagramMedia(url, {
      igCookie
    });

    res.json(data);
  } catch (err) {
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

app.get("/download", async (req, res) => {
  try {
    const mediaUrl = req.query.url;
    const igCookie = normalizeIgCookie(req.headers[PRIVATE_COOKIE_HEADER] || "");

    if (!mediaUrl) {
      return res.status(400).send("Thiếu url");
    }

    const u = new URL(mediaUrl);

    if (!u.hostname.includes("fbcdn.net")) {
      return res.status(400).send("Chỉ cho tải media fbcdn.net");
    }

    const headers = {
      "user-agent": MOBILE_UA,
      referer: "https://www.instagram.com/"
    };

    if (igCookie) {
      headers.cookie = igCookie;
    }

    const response = await fetch(mediaUrl, {
      headers
    });

    if (!response.ok) {
      return res.status(response.status).send("Không tải được media");
    }

    const contentType = response.headers.get("content-type") || "";
    const ext = contentType.includes("video") ? "mp4" : "jpg";
    const filename = `instagram-${nanoid(8)}.${ext}`;

    res.setHeader("Content-Type", contentType);
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${filename}"`
    );

    const arrayBuffer = await response.arrayBuffer();

    res.send(Buffer.from(arrayBuffer));
  } catch (err) {
    res.status(500).send(err.message);
  }
});

app.listen(3000, () => {
  console.log("🚀 Server chạy tại http://localhost:3000");

  startInstagramSessionWatcher();
});

async function shutdown() {
  if (igContext) {
    await igContext.close().catch(() => {});
  }

  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);