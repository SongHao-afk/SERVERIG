const { normalizeIgCookie } = require("../utils/cookie");
const {
  isInstagramUrl,
  isInstagramStoryUrl,
  getInstagramShortcode,
  getInstagramStoryPk
} = require("../utils/ig-url");
const { getInstagramContext, createPrivateCookieContext } = require("./context");
const { checkInstagramSessionWithRetry } = require("./session");
const { getSessionStatus } = require("./state");
const { closeInstagramPopups, switchToHtmlMode } = require("./page");
const { extractMediaFromHtml } = require("./media-utils");

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
      if (!getSessionStatus().ok) {
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

    const type = media.some(x => x.type === "video")
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

module.exports = {
  resolveByHtml,
  extractInstagramMedia
};