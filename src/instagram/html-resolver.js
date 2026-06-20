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

function cleanUrl(value) {
  return String(value || "")
    .replaceAll("\\u0026", "&")
    .replaceAll("\\/", "/")
    .replaceAll("&amp;", "&");
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function firstNonEmpty(values) {
  for (const value of values) {
    const clean = cleanText(value);

    if (clean) {
      return clean;
    }
  }

  return "";
}

function normalizeProfile(profile = {}) {
  return {
    username: cleanText(profile.username || profile.ownerUsername || ""),
    fullName: cleanText(profile.fullName || profile.full_name || ""),
    avatarUrl: cleanUrl(
      profile.avatarUrl ||
        profile.profilePicUrl ||
        profile.profile_pic_url ||
        profile.ownerAvatarUrl ||
        ""
    ),
  };
}

function mergeProfile(...profiles) {
  const normalized = profiles.map((x) => normalizeProfile(x || {}));

  return {
    username: firstNonEmpty(normalized.map((x) => x.username)),
    fullName: firstNonEmpty(normalized.map((x) => x.fullName)),
    avatarUrl: firstNonEmpty(normalized.map((x) => x.avatarUrl)),
  };
}

function getProfileFromItems(items) {
  if (!Array.isArray(items)) {
    return normalizeProfile();
  }

  const found = items.find((item) => {
    return (
      item &&
      (item.username ||
        item.fullName ||
        item.full_name ||
        item.avatarUrl ||
        item.profilePicUrl ||
        item.profile_pic_url)
    );
  });

  return normalizeProfile(found || {});
}

function attachProfileToMedia(media, profile) {
  if (Array.isArray(media)) {
    media.profile = normalizeProfile(profile);
  }

  return media;
}

async function extractPageProfileInfo(page) {
  try {
    return await page.evaluate(() => {
      const RESERVED_PATHS = new Set([
        "p",
        "reel",
        "reels",
        "tv",
        "stories",
        "explore",
        "accounts",
        "direct",
        "challenge",
        "about",
        "developer",
        "legal",
        "privacy",
        "terms",
        "api",
        "oauth",
      ]);

      function cleanText(value) {
        return String(value || "").replace(/\s+/g, " ").trim();
      }

      function cleanUrl(value) {
        return String(value || "")
          .replaceAll("\\u0026", "&")
          .replaceAll("\\/", "/")
          .replaceAll("&amp;", "&");
      }

      function escapeRegExp(value) {
        return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      }

      function getMeta(selector) {
        const el = document.querySelector(selector);
        return cleanText(el?.getAttribute("content") || "");
      }

      function isGoodUsername(value) {
        const clean = cleanText(value).replace(/^@/, "");

        if (!clean) return false;
        if (RESERVED_PATHS.has(clean.toLowerCase())) return false;

        return /^[A-Za-z0-9._]{2,30}$/.test(clean);
      }

      function getRoot() {
        return (
          document.querySelector("article") ||
          document.querySelector("main") ||
          document.body
        );
      }

      function getUsernameFromLinks() {
        const root = getRoot();
        const anchors = [...root.querySelectorAll('a[href^="/"]')];

        for (const a of anchors) {
          try {
            const href = a.getAttribute("href") || "";
            const url = new URL(href, location.origin);
            const parts = url.pathname.split("/").filter(Boolean);

            if (parts.length !== 1) continue;

            const candidate = parts[0];

            if (isGoodUsername(candidate)) {
              return candidate;
            }
          } catch {}
        }

        return "";
      }

      function getScriptText() {
        return [...document.scripts]
          .map((script) => script.textContent || "")
          .filter(Boolean)
          .join("\n");
      }

      function findJsonValue(patterns) {
        const text = getScriptText();

        for (const pattern of patterns) {
          const match = text.match(pattern);

          if (match && match[1]) {
            return cleanUrl(match[1]);
          }
        }

        return "";
      }

      function getUsernameFromMeta() {
        const candidates = [
          document.title,
          getMeta('meta[property="og:title"]'),
          getMeta('meta[name="description"]'),
          getMeta('meta[property="og:description"]'),
        ].join(" ");

        let match = candidates.match(/@([A-Za-z0-9._]{2,30})/);

        if (match && isGoodUsername(match[1])) {
          return match[1];
        }

        match = candidates.match(/^([A-Za-z0-9._]{2,30})\s+on Instagram/i);

        if (match && isGoodUsername(match[1])) {
          return match[1];
        }

        return "";
      }

      function getUsernameFromJson() {
        return findJsonValue([
          /"owner"\s*:\s*\{[\s\S]{0,1200}?"username"\s*:\s*"([^"]+)"/,
          /"user"\s*:\s*\{[\s\S]{0,1200}?"username"\s*:\s*"([^"]+)"/,
          /"ownerUsername"\s*:\s*"([^"]+)"/,
          /"owner_username"\s*:\s*"([^"]+)"/,
          /"username"\s*:\s*"([^"]+)"/,
          /"alternateName"\s*:\s*"@?([^"]+)"/,
        ]);
      }

      function getFullNameFromMeta() {
        const ogTitle =
          getMeta('meta[property="og:title"]') || cleanText(document.title);

        const match = ogTitle.match(/^(.+?)\s+on Instagram/i);

        if (match && match[1]) {
          return cleanText(match[1].replace(/^@/, ""));
        }

        return "";
      }

      function getFullNameFromJson() {
        return findJsonValue([
          /"owner"\s*:\s*\{[\s\S]{0,1600}?"full_name"\s*:\s*"([^"]+)"/,
          /"user"\s*:\s*\{[\s\S]{0,1600}?"full_name"\s*:\s*"([^"]+)"/,
          /"full_name"\s*:\s*"([^"]+)"/,
          /"fullName"\s*:\s*"([^"]+)"/,
          /"name"\s*:\s*"([^"]+)"/,
        ]);
      }

      function getAvatarFromOwnerLink(username) {
        const cleanUsername = cleanText(username).replace(/^@/, "");

        if (!cleanUsername) return "";

        const root = getRoot();

        const links = [
          ...root.querySelectorAll(`a[href="/${cleanUsername}/"]`),
          ...root.querySelectorAll(`a[href="/${cleanUsername}"]`),
        ];

        for (const link of links) {
          const candidates = [
            link.querySelector("img"),
            link.closest("header")?.querySelector("img"),
            link.closest("article")?.querySelector(
              `a[href="/${cleanUsername}/"] img, a[href="/${cleanUsername}"] img`
            ),
          ].filter(Boolean);

          for (const img of candidates) {
            const src = cleanUrl(img.currentSrc || img.src || "");

            if (!src) continue;
            if (src.startsWith("blob:")) continue;

            const isCdn =
              src.includes("cdninstagram.com") ||
              src.includes("fbcdn.net") ||
              src.includes("scontent");

            if (!isCdn) continue;

            return src;
          }
        }

        return "";
      }

      function getAvatarFromJsonNearUsername(username) {
        const cleanUsername = cleanText(username).replace(/^@/, "");

        if (!cleanUsername) return "";

        const text = getScriptText();
        const u = escapeRegExp(cleanUsername);

        const patterns = [
          new RegExp(
            `"owner"\\s*:\\s*\\{[\\s\\S]{0,2200}?"username"\\s*:\\s*"${u}"[\\s\\S]{0,2200}?"profile_pic_url_hd"\\s*:\\s*"([^"]+)"`,
            "i"
          ),
          new RegExp(
            `"owner"\\s*:\\s*\\{[\\s\\S]{0,2200}?"username"\\s*:\\s*"${u}"[\\s\\S]{0,2200}?"profile_pic_url"\\s*:\\s*"([^"]+)"`,
            "i"
          ),
          new RegExp(
            `"user"\\s*:\\s*\\{[\\s\\S]{0,2200}?"username"\\s*:\\s*"${u}"[\\s\\S]{0,2200}?"profile_pic_url_hd"\\s*:\\s*"([^"]+)"`,
            "i"
          ),
          new RegExp(
            `"user"\\s*:\\s*\\{[\\s\\S]{0,2200}?"username"\\s*:\\s*"${u}"[\\s\\S]{0,2200}?"profile_pic_url"\\s*:\\s*"([^"]+)"`,
            "i"
          ),
          new RegExp(
            `"username"\\s*:\\s*"${u}"[\\s\\S]{0,2600}?"profile_pic_url_hd"\\s*:\\s*"([^"]+)"`,
            "i"
          ),
          new RegExp(
            `"username"\\s*:\\s*"${u}"[\\s\\S]{0,2600}?"profile_pic_url"\\s*:\\s*"([^"]+)"`,
            "i"
          ),
          new RegExp(
            `"profile_pic_url_hd"\\s*:\\s*"([^"]+)"[\\s\\S]{0,2600}?"username"\\s*:\\s*"${u}"`,
            "i"
          ),
          new RegExp(
            `"profile_pic_url"\\s*:\\s*"([^"]+)"[\\s\\S]{0,2600}?"username"\\s*:\\s*"${u}"`,
            "i"
          ),
        ];

        for (const pattern of patterns) {
          const match = text.match(pattern);

          if (match && match[1]) {
            return cleanUrl(match[1]);
          }
        }

        return "";
      }

      const username = cleanText(
        getUsernameFromJson() || getUsernameFromLinks() || getUsernameFromMeta()
      ).replace(/^@/, "");

      const fullName = cleanText(getFullNameFromJson() || getFullNameFromMeta());

      const avatarUrl = cleanUrl(
        getAvatarFromOwnerLink(username) ||
          getAvatarFromJsonNearUsername(username)
      );

      return {
        username,
        fullName,
        avatarUrl,
      };
    });
  } catch {
    return {
      username: "",
      fullName: "",
      avatarUrl: "",
    };
  }
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

  let profile = await extractPageProfileInfo(page);
  let media = await extractMediaFromHtml(page, igUrl);

  if (media.length > 0) {
    return attachProfileToMedia(media, profile);
  }

  try {
    await page.evaluate(() => window.scrollBy(0, 700));
  } catch {}

  await page.waitForTimeout(700);

  profile = mergeProfile(profile, await extractPageProfileInfo(page));
  media = await extractMediaFromHtml(page, igUrl);

  if (media.length > 0) {
    return attachProfileToMedia(media, profile);
  }

  await page.reload({
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  await page.waitForTimeout(1500);
  await closeInstagramPopups(page);

  profile = mergeProfile(profile, await extractPageProfileInfo(page));
  media = await extractMediaFromHtml(page, igUrl);

  return attachProfileToMedia(media, profile);
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

  return type === "reel" || type === "reels" || type === "p";
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

function getStoryGroupResponseType(media) {
  if (!media.length) return "image";

  if (media.length > 1) {
    return "carousel";
  }

  return media[0].type || "image";
}

function normalizeStoryGroupItem(item, index, meta = {}) {
  const type = item.type || "image";
  const profile = normalizeProfile(meta.profile || {});

  return {
    id: index + 1,
    storyId: item.id || item.pk || null,
    index: index + 1,
    type,
    width: item.width || null,
    height: item.height || null,
    duration: item.duration || null,
    downloadUrl: cleanUrl(item.downloadUrl),
    thumbnailUrl: cleanUrl(
      item.thumbnailUrl || (type === "image" ? item.downloadUrl : "")
    ),
    sourceUrl: cleanUrl(item.sourceUrl || meta.sourceUrl || ""),
    shortcode: cleanText(item.shortcode || meta.mediaKey || ""),
    username: cleanText(item.username || profile.username),
    fullName: cleanText(item.fullName || item.full_name || profile.fullName),
    avatarUrl: cleanUrl(
      item.avatarUrl ||
        item.profilePicUrl ||
        item.profile_pic_url ||
        profile.avatarUrl
    ),
    takenAt: item.takenAt || item.taken_at || null,
    mediaType: item.mediaType || item.media_type || null,
  };
}

// Giữ tên cũ để khỏi phải sửa route/import khác.
// Trước đây hàm này chỉ trả story đầu tiên.
// Bây giờ nó trả TOÀN BỘ story items load được trong group/highlight.
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

  const rawItems = Array.isArray(storyData.items) ? storyData.items : [];

  const validItems = rawItems.filter((item) => {
    return item && item.downloadUrl;
  });

  if (!validItems.length) {
    throw new Error(
      "Không bắt được media story trong group/highlight. Có thể story đã hết hạn, account không có quyền xem, hoặc session Instagram hết hạn."
    );
  }

  const mediaKey =
    getInstagramStoryGroupKey(normalizedIgUrl) ||
    getInstagramStoryUsername(normalizedIgUrl) ||
    params.groupId ||
    "story-group";

  const storyProfile = mergeProfile(storyData.profile || {}, getProfileFromItems(rawItems), {
    username: params.username,
  });

  const media = validItems.map((item, index) =>
    normalizeStoryGroupItem(item, index, {
      sourceUrl: normalizedIgUrl,
      mediaKey,
      profile: storyProfile,
    })
  );

  const responseType = getStoryGroupResponseType(media);

  logResolveOk({
    mode,
    kind: "STORY_GROUP",
    engine: storyData.mode || "story-profile-api",
    type: responseType,
    total: media.length,
    mediaKey,
  });

  return {
    success: true,
    type: responseType,
    total: media.length,
    totalAvailable: rawItems.length,
    limit: "all",
    kind: params.kind,
    groupId: params.groupId,
    source: igUrl,
    normalizedSource: normalizedIgUrl,
    mediaKey,
    profile: storyProfile,
    mode: storyData.mode || "story-profile-api",
    media,
  };
}

function normalizeMediaResult(items, meta = {}) {
  const incomingProfile = mergeProfile(
    meta.profile || {},
    items?.profile || {},
    getProfileFromItems(items || [])
  );

  const sourceUrl = cleanUrl(meta.normalizedSource || meta.source || "");
  const mediaKey = cleanText(meta.mediaKey || "");

  const uniqueItems = [
    ...new Map(
      (items || [])
        .filter((item) => item && item.downloadUrl)
        .map((item) => [cleanUrl(item.downloadUrl), item])
    ).values(),
  ];

  const media = uniqueItems.map((item, i) => {
    const type = item.type || "image";

    const itemProfile = mergeProfile(item, incomingProfile);

    return {
      id: i + 1,
      type,
      width: item.width || null,
      height: item.height || null,
      duration: item.duration || null,
      downloadUrl: cleanUrl(item.downloadUrl),
      thumbnailUrl: cleanUrl(
        item.thumbnailUrl || (type === "image" ? item.downloadUrl : "")
      ),
      shortcode: cleanText(item.shortcode || mediaKey),
      sourceUrl: cleanUrl(item.sourceUrl || sourceUrl),
      username: itemProfile.username,
      fullName: itemProfile.fullName,
      avatarUrl: itemProfile.avatarUrl,
    };
  });

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
    profile: incomingProfile,
  };
}

function getKindFromPath({ isStory, pathType }) {
  if (isStory) return "STORY_WITH_ID";
  if (pathType === "p") return "POST_PHOTO";
  if (pathType === "reel" || pathType === "reels") return "REEL";
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

      const normalizedPublic = normalizeMediaResult(publicMedia, {
        source: igUrl,
        normalizedSource: normalizedIgUrl,
        mediaKey,
        profile: publicMedia?.profile || {},
      });

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
          profile: normalizedPublic.profile,
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

    const normalizedPost = normalizeMediaResult(postMedia, {
      source: igUrl,
      normalizedSource: normalizedIgUrl,
      mediaKey,
      profile: postMedia?.profile || {},
    });

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
      profile: normalizedPost.profile,
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