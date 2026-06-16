const { normalizeIgCookie } = require("../utils/cookie");
const {
  isInstagramUrl,
  isInstagramStoryUrl,
  isInstagramStoryGroupUrl,
  getInstagramShortcode,
  normalizeInstagramMediaUrl,
  getInstagramStoryPk,
  getInstagramStoryGroupKey,
  getInstagramStoryUsername,
} = require("../utils/ig-url");

const { getInstagramContext, createPrivateCookieContext } = require("./context");
const { checkInstagramSessionWithRetry } = require("./session");
const { getSessionStatus } = require("./state");
const { closeInstagramPopups, switchToHtmlMode } = require("./page");
const { extractMediaFromHtml } = require("./media-utils");
const { extractProfileStoryGroupItems } = require("./profile");

let resolvePublicMedia = null;

try {
  ({ resolvePublicMedia } = require("./public-resolver"));
} catch {
  resolvePublicMedia = null;
}

function getLogMode(privateMode, noLogin = false) {
  if (noLogin) return "PUBLIC NO-LOGIN";
  if (privateMode) return "PRIVATE COOKIE";
  return "PUBLIC DEFAULT SESSION";
}

function logResolveStart({ mode, kind, engine, mediaKey = "" }) {
  console.log(
    `🧭 START | mode=${mode} | kind=${kind} | engine=${engine}${
      mediaKey ? ` | mediaKey=${mediaKey}` : ""
    }`
  );
}

function logResolveOk({ mode, kind, engine, type, total, mediaKey = "" }) {
  console.log(
    `✅ OK | mode=${mode} | kind=${kind} | engine=${engine} | type=${type} | total=${total}${
      mediaKey ? ` | mediaKey=${mediaKey}` : ""
    }`
  );
}

function logResolveFallback({ fromMode, toMode, kind, reason = "" }) {
  console.warn(
    `⚠️ FALLBACK | from=${fromMode} | to=${toMode} | kind=${kind}${
      reason ? ` | reason=${reason}` : ""
    }`
  );
}

async function resolveByHtml(page, igUrl, igCookie = "") {
  await switchToHtmlMode(page, igCookie);

  await page.goto(igUrl, {
    waitUntil: "domcontentloaded",
    timeout: 60000,
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
    timeout: 60000,
  });

  await page.waitForTimeout(1500);
  await closeInstagramPopups(page);

  media = await extractMediaFromHtml(page, igUrl);

  return media;
}

function getMediaPathType(igUrl) {
  try {
    const u = new URL(igUrl);
    const parts = u.pathname.split("/").filter(Boolean);

    return parts[0] || "";
  } catch {
    return "";
  }
}

function shouldTryPublicNoLogin(normalizedIgUrl, isStory, privateMode) {
  if (isStory) return false;
  if (privateMode) return false;
  if (!resolvePublicMedia) return false;

  const type = getMediaPathType(normalizedIgUrl);

  return type === "reel" || type === "p";
}

function getStoryGroupParamsFromUrl(storyUrl) {
  const u = new URL(storyUrl);
  const parts = u.pathname.split("/").filter(Boolean);

  if (
    parts.length >= 3 &&
    parts[0] === "stories" &&
    parts[1] === "highlights"
  ) {
    const highlightId = parts[2];

    return {
      groupId: `highlight:${highlightId}`,
      username: "",
      userId: "",
      kind: "highlight",
    };
  }

  if (
    parts.length >= 2 &&
    parts[0] === "stories" &&
    parts[1] !== "highlights"
  ) {
    const username = parts[1];

    return {
      groupId: `active:${username}`,
      username,
      userId: "",
      kind: "active_story",
    };
  }

  throw new Error("URL story group không hợp lệ");
}

async function extractFirstStoryMedia(igUrl, options = {}) {
  const igCookie = normalizeIgCookie(options.igCookie || "");
  const privateMode = Boolean(igCookie);
  const mode = getLogMode(privateMode, false);

  if (!isInstagramUrl(igUrl)) {
    throw new Error("URL không phải Instagram");
  }

  const normalizedIgUrl = normalizeInstagramMediaUrl(igUrl);

  if (!isInstagramStoryGroupUrl(normalizedIgUrl)) {
    throw new Error("URL này không phải story group Instagram");
  }

  logResolveStart({
    mode,
    kind: "STORY_GROUP",
    engine: "story-profile-api",
  });

  const params = getStoryGroupParamsFromUrl(normalizedIgUrl);

  const storyData = await extractProfileStoryGroupItems(
    {
      groupId: params.groupId,
      username: params.username,
      userId: params.userId,
    },
    {
      igCookie,
    }
  );

  const firstItem = Array.isArray(storyData.items) ? storyData.items[0] : null;

  if (!firstItem || !firstItem.downloadUrl) {
    throw new Error(
      "Không bắt được media story đầu tiên. Có thể story đã hết hạn, account không có quyền xem, hoặc session Instagram hết hạn."
    );
  }

  const media = [
    {
      id: 1,
      type: firstItem.type || "image",
      width: firstItem.width || null,
      height: firstItem.height || null,
      duration: firstItem.duration || null,
      downloadUrl: firstItem.downloadUrl,
      thumbnailUrl:
        firstItem.thumbnailUrl ||
        (firstItem.type === "image" ? firstItem.downloadUrl : null),
    },
  ];

  const mediaKey =
    firstItem.id ||
    getInstagramStoryGroupKey(normalizedIgUrl) ||
    getInstagramStoryUsername(normalizedIgUrl) ||
    "story-first";

  logResolveOk({
    mode,
    kind: "STORY_GROUP",
    engine: storyData.mode || "story-profile-api",
    type: media[0].type,
    total: 1,
    mediaKey,
  });

  return {
    success: true,
    type: media[0].type,
    total: 1,
    source: igUrl,
    normalizedSource: normalizedIgUrl,
    mediaKey,
    mode: storyData.mode || "story-profile-api",
    media,
  };
}

function normalizeMediaResult(items) {
  const uniqueItems = [
    ...new Map(
      items
        .filter((item) => item && item.downloadUrl)
        .map((item) => [item.downloadUrl, item])
    ).values(),
  ];

  const media = uniqueItems.map((item, i) => ({
    id: i + 1,
    type: item.type || "image",
    width: item.width || null,
    height: item.height || null,
    duration: item.duration || null,
    downloadUrl: item.downloadUrl,
    thumbnailUrl:
      item.thumbnailUrl || (item.type === "image" ? item.downloadUrl : null),
  }));

  const type = media.some((x) => x.type === "video")
    ? media.length > 1
      ? "carousel"
      : "video"
    : media.length > 1
    ? "carousel"
    : "image";

  return {
    media,
    type,
  };
}

function getKindFromPath({ isStory, pathType }) {
  if (isStory) return "STORY_WITH_ID";
  if (pathType === "p") return "POST_PHOTO";
  if (pathType === "reel") return "REEL";
  if (pathType === "tv") return "TV";

  return "MEDIA";
}

async function extractInstagramMedia(igUrl, options = {}) {
  const igCookie = normalizeIgCookie(options.igCookie || "");
  const privateMode = Boolean(igCookie);

  if (!isInstagramUrl(igUrl)) {
    throw new Error("URL không phải Instagram");
  }

  const normalizedIgUrl = normalizeInstagramMediaUrl(igUrl);
  const isStory = isInstagramStoryUrl(normalizedIgUrl);
  const pathType = getMediaPathType(normalizedIgUrl);
  const kind = getKindFromPath({ isStory, pathType });

  if (isStory && isInstagramStoryGroupUrl(normalizedIgUrl)) {
    return await extractFirstStoryMedia(normalizedIgUrl, options);
  }

  const mediaKey = isStory
    ? getInstagramStoryPk(normalizedIgUrl)
    : getInstagramShortcode(normalizedIgUrl);

  if (!mediaKey) {
    throw new Error("Không lấy được mã media từ URL Instagram");
  }

  if (shouldTryPublicNoLogin(normalizedIgUrl, isStory, privateMode)) {
    const noLoginMode = getLogMode(false, true);

    logResolveStart({
      mode: noLoginMode,
      kind,
      engine: "public-resolver",
      mediaKey,
    });

    try {
      const publicMedia = await resolvePublicMedia(normalizedIgUrl);
      const normalizedPublic = normalizeMediaResult(publicMedia);

      if (normalizedPublic.media.length > 0) {
        logResolveOk({
          mode: noLoginMode,
          kind,
          engine: "public-resolver",
          type: normalizedPublic.type,
          total: normalizedPublic.media.length,
          mediaKey,
        });

        return {
          success: true,
          type: normalizedPublic.type,
          total: normalizedPublic.media.length,
          source: igUrl,
          normalizedSource: normalizedIgUrl,
          mediaKey,
          mode: "public-no-login",
          media: normalizedPublic.media,
        };
      }

      logResolveFallback({
        fromMode: noLoginMode,
        toMode: "PUBLIC DEFAULT SESSION",
        kind,
        reason: "no media from public-resolver",
      });
    } catch (err) {
      logResolveFallback({
        fromMode: noLoginMode,
        toMode: "PUBLIC DEFAULT SESSION",
        kind,
        reason: err.message,
      });
    }
  }

  const htmlMode = getLogMode(privateMode, false);

  logResolveStart({
    mode: htmlMode,
    kind,
    engine: "html-resolver",
    mediaKey,
  });

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
        const ok = await checkInstagramSessionWithRetry(
          "resolve-auto-check",
          false
        );

        if (!ok) {
          throw new Error(
            "Default Instagram session chưa đăng nhập hoặc đã hết hạn.\nMở /setup-login để login lại."
          );
        }
      }

      context = await getInstagramContext();
    }

    page = await context.newPage();

    const postMedia = await resolveByHtml(page, normalizedIgUrl, igCookie);
    const normalizedPost = normalizeMediaResult(postMedia);

    if (normalizedPost.media.length === 0) {
      throw new Error(
        privateMode
          ? "Không bắt được media. Có thể cookie private hết hạn hoặc account không có quyền xem link này."
          : "Không bắt được media từ HTML Instagram.\nCó thể link private/expired hoặc default session không có quyền xem."
      );
    }

    logResolveOk({
      mode: htmlMode,
      kind,
      engine: "html-resolver",
      type: normalizedPost.type,
      total: normalizedPost.media.length,
      mediaKey,
    });

    return {
      success: true,
      type: normalizedPost.type,
      total: normalizedPost.media.length,
      source: igUrl,
      normalizedSource: normalizedIgUrl,
      mediaKey,
      mode: privateMode ? "private-client-cookie" : "public-default-session",
      media: normalizedPost.media,
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
  extractFirstStoryMedia,
  extractInstagramMedia,
};