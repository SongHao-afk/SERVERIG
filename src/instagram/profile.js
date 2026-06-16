const { normalizeIgCookie } = require("../utils/cookie");
const { extractInstagramUsername } = require("../utils/ig-url");
const { makeDownloadKey, parseDownloadKey } = require("../utils/encoding");
const { getInstagramContext, createPrivateCookieContext } = require("./context");
const { checkInstagramSessionWithRetry } = require("./session");
const { getSessionStatus } = require("./state");
const { prepareInstagramApiPage } = require("./page");
const { igApiJson } = require("./api");
const { cleanIgUrl, getBestThumbnailUrl, mediaItemToOutput } = require("./media-utils");

function normalizeHighlightGroupId(rawId) {
  const clean = String(rawId || "").trim();

  if (!clean) return "";

  return clean.startsWith("highlight:") ? clean : `highlight:${clean}`;
}

function getHighlightIdOnly(groupId) {
  return String(groupId || "").replace(/^highlight:/, "");
}

function isActiveStoryGroupId(groupId) {
  return String(groupId || "").startsWith("active:");
}

function isHighlightGroupId(groupId) {
  return String(groupId || "").startsWith("highlight:");
}

function getStoryItemId(item) {
  return String(item?.pk || item?.id || item?.media_id || item?.taken_at || "");
}

function getCoverUrlFromMediaLike(mediaLike) {
  if (!mediaLike) return null;

  const coverCandidates = [
    mediaLike?.cover_media?.cropped_image_version?.url,
    mediaLike?.cover_media?.image_versions2?.candidates?.[0]?.url,
    mediaLike?.cover_media?.thumbnail_url,
    mediaLike?.thumbnail_url,
    mediaLike?.user?.profile_pic_url,
    mediaLike?.owner?.profile_pic_url
  ];

  for (const url of coverCandidates) {
    if (url) return cleanIgUrl(url);
  }

  if (Array.isArray(mediaLike?.items) && mediaLike.items.length > 0) {
    return getBestThumbnailUrl(mediaLike.items[0]);
  }

  return null;
}

function getReelFromApiData(data, reelId = "") {
  if (!data) return null;

  if (data.reel) return data.reel;

  if (Array.isArray(data.reels_media) && data.reels_media.length > 0) {
    return data.reels_media[0];
  }

  if (data.reels && typeof data.reels === "object") {
    const exact = data.reels[reelId];

    if (exact) return exact;

    const first = Object.values(data.reels)[0];

    if (first) return first;
  }

  return null;
}

function getTrayFromApiData(data) {
  if (!data) return [];

  const tray = data.tray || data.highlight_tray || data.reels_tray || data.items || [];

  return Array.isArray(tray) ? tray : [];
}

async function createContextForProfileRequest(igCookie = "") {
  const privateMode = Boolean(normalizeIgCookie(igCookie));

  if (privateMode) {
    const privateContextBundle = await createPrivateCookieContext(igCookie);

    return {
      privateMode,
      privateBrowser: privateContextBundle.browser,
      context: privateContextBundle.context
    };
  }

  if (!getSessionStatus().ok) {
    const ok = await checkInstagramSessionWithRetry("profile-auto-check", false);

    if (!ok) {
      throw new Error(
        "Default Instagram session chưa đăng nhập hoặc đã hết hạn. Mở /setup-login để login lại."
      );
    }
  }

  return {
    privateMode,
    privateBrowser: null,
    context: await getInstagramContext()
  };
}

async function fetchWebProfileInfo(page, username) {
  const data = await igApiJson(
    page,
    `/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`
  );

  const user = data?.data?.user;

  if (!user) {
    throw new Error("Không lấy được thông tin profile Instagram");
  }

  return {
    userId: String(user.id || user.pk || ""),
    username: user.username || username,
    fullName: user.full_name || "",
    avatarUrl: cleanIgUrl(user.profile_pic_url_hd || user.profile_pic_url || ""),
    isPrivate: Boolean(user.is_private),
    isVerified: Boolean(user.is_verified),
    hasPublicStory: Boolean(user.has_public_story)
  };
}

async function fetchActiveStoryReel(page, userId) {
  const errors = [];

  const paths = [
    `/api/v1/feed/user/${encodeURIComponent(userId)}/story/`,
    `/api/v1/feed/reels_media/?reel_ids=${encodeURIComponent(userId)}`
  ];

  for (const path of paths) {
    try {
      const data = await igApiJson(page, path);
      const reel = getReelFromApiData(data, userId);

      if (reel && Array.isArray(reel.items)) {
        return reel;
      }
    } catch (err) {
      errors.push(err.message);
    }
  }

  console.log("⚠️ Không lấy được active story:", errors.join(" | "));

  return null;
}

async function fetchHighlightTray(page, userId) {
  const errors = [];

  const paths = [
    `/api/v1/highlights/${encodeURIComponent(userId)}/highlights_tray/`,
    `/api/v1/highlights/${encodeURIComponent(userId)}/highlights_tray/?include_cover=1`
  ];

  for (const path of paths) {
    try {
      const data = await igApiJson(page, path);
      const tray = getTrayFromApiData(data);

      if (tray.length > 0) {
        return tray;
      }

      return [];
    } catch (err) {
      errors.push(err.message);
    }
  }

  console.log("⚠️ Không lấy được highlight tray:", errors.join(" | "));

  return [];
}

async function fetchHighlightReel(page, groupId) {
  const highlightId = getHighlightIdOnly(groupId);
  const reelId = `highlight:${highlightId}`;

  const data = await igApiJson(
    page,
    `/api/v1/feed/reels_media/?reel_ids=${encodeURIComponent(reelId)}`
  );

  return getReelFromApiData(data, reelId);
}

function storyItemToProfileOutput(item, index, meta) {
  const mediaOut = mediaItemToOutput(item);

  if (!mediaOut) return null;

  const itemId = getStoryItemId(item);

  if (!itemId) return null;

  const sourceUrl =
    meta.kind === "active_story" && meta.username
      ? `https://www.instagram.com/stories/${meta.username}/${itemId}/`
      : null;

  const downloadKey = makeDownloadKey({
    kind: meta.kind,
    groupId: meta.groupId,
    username: meta.username || "",
    userId: meta.userId || "",
    itemId,
    index
  });

  return {
    id: itemId,
    index,
    type: mediaOut.type || "image",
    width: mediaOut.width || null,
    height: mediaOut.height || null,
    duration: mediaOut.duration || null,
    thumbnailUrl:
      mediaOut.thumbnailUrl ||
      (mediaOut.type === "image" ? mediaOut.downloadUrl : null),
    downloadUrl: mediaOut.downloadUrl,
    downloadKey,
    sourceUrl,
    takenAt: item.taken_at || item.device_timestamp || null
  };
}

function reelItemsToOutput(reel, meta) {
  const items = Array.isArray(reel?.items) ? reel.items : [];

  return items
    .map((item, index) => storyItemToProfileOutput(item, index + 1, meta))
    .filter(Boolean);
}

async function extractProfileStoryGroups(profileUrl, options = {}) {
  const igCookie = normalizeIgCookie(options.igCookie || "");
  const username = extractInstagramUsername(profileUrl);

  let page = null;
  let privateBrowser = null;

  try {
    const requestContext = await createContextForProfileRequest(igCookie);
    privateBrowser = requestContext.privateBrowser;

    page = await requestContext.context.newPage();

    await prepareInstagramApiPage(page, username, igCookie);

    const profile = await fetchWebProfileInfo(page, username);

    if (!profile.userId) {
      throw new Error("Không lấy được userId của profile");
    }

    const groups = [];
    const warnings = [];

    try {
      const activeReel = await fetchActiveStoryReel(page, profile.userId);
      const activeItems = Array.isArray(activeReel?.items) ? activeReel.items : [];

      if (activeItems.length > 0) {
        groups.push({
          id: `active:${profile.username}`,
          kind: "active_story",
          title: "Story hiện tại",
          coverUrl:
            getCoverUrlFromMediaLike(activeReel) ||
            getBestThumbnailUrl(activeItems[0]) ||
            profile.avatarUrl ||
            null,
          itemCount: activeItems.length,
          userId: profile.userId,
          username: profile.username
        });
      }
    } catch (err) {
      warnings.push(`active_story: ${err.message}`);
    }

    try {
      const tray = await fetchHighlightTray(page, profile.userId);

      for (const highlight of tray) {
        const highlightId = normalizeHighlightGroupId(
          highlight.id || highlight.pk || highlight.reel_id || highlight.highlight_id
        );

        if (!highlightId) continue;

        groups.push({
          id: highlightId,
          kind: "highlight",
          title: highlight.title || highlight.name || highlight.label || "Tin nổi bật",
          coverUrl: getCoverUrlFromMediaLike(highlight) || profile.avatarUrl || null,
          itemCount:
            highlight.media_count || highlight.item_count || highlight.latest_reel_media || null,
          userId: profile.userId,
          username: profile.username
        });
      }
    } catch (err) {
      warnings.push(`highlight: ${err.message}`);
    }

    return {
      success: true,
      mode: requestContext.privateMode
        ? "private-client-cookie"
        : "public-default-session",
      profile: {
        username: profile.username,
        userId: profile.userId,
        fullName: profile.fullName,
        avatarUrl: profile.avatarUrl,
        isPrivate: profile.isPrivate,
        isVerified: profile.isVerified
      },
      totalGroups: groups.length,
      groups,
      warnings
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

async function extractProfileStoryGroupItems(params = {}, options = {}) {
  const igCookie = normalizeIgCookie(options.igCookie || "");
  const rawGroupId = String(params.groupId || "").trim();

  if (!rawGroupId) {
    throw new Error("Thiếu groupId");
  }

  let username = params.username ? extractInstagramUsername(params.username) : "";
  let userId = String(params.userId || "").trim();

  let page = null;
  let privateBrowser = null;

  try {
    const requestContext = await createContextForProfileRequest(igCookie);
    privateBrowser = requestContext.privateBrowser;

    page = await requestContext.context.newPage();

    const firstUsername =
      username ||
      (isActiveStoryGroupId(rawGroupId) ? rawGroupId.replace(/^active:/, "") : "");

    await prepareInstagramApiPage(page, firstUsername, igCookie);

    if ((!username || !userId) && firstUsername) {
      const profile = await fetchWebProfileInfo(page, firstUsername);
      username = profile.username;
      userId = profile.userId;
    }

    let reel = null;
    let groupId = rawGroupId;
    let kind = "";

    if (isActiveStoryGroupId(rawGroupId)) {
      kind = "active_story";

      if (!username) {
        username = rawGroupId.replace(/^active:/, "");
      }

      if (!userId) {
        const profile = await fetchWebProfileInfo(page, username);
        username = profile.username;
        userId = profile.userId;
      }

      reel = await fetchActiveStoryReel(page, userId);
      groupId = `active:${username}`;
    } else if (isHighlightGroupId(rawGroupId)) {
      kind = "highlight";
      groupId = normalizeHighlightGroupId(rawGroupId);
      reel = await fetchHighlightReel(page, groupId);
    } else {
      throw new Error("groupId phải có dạng active:username hoặc highlight:id");
    }

    if (!reel || !Array.isArray(reel.items) || reel.items.length === 0) {
      return {
        success: true,
        mode: requestContext.privateMode
          ? "private-client-cookie"
          : "public-default-session",
        groupId,
        kind,
        title: reel?.title || "",
        total: 0,
        items: []
      };
    }

    const items = reelItemsToOutput(reel, {
      kind,
      groupId,
      username,
      userId
    });

    return {
      success: true,
      mode: requestContext.privateMode
        ? "private-client-cookie"
        : "public-default-session",
      groupId,
      kind,
      title:
        kind === "active_story"
          ? "Story hiện tại"
          : reel.title || reel.name || "Tin nổi bật",
      coverUrl: getCoverUrlFromMediaLike(reel),
      total: items.length,
      items
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

async function resolveProfileDownloadItem(downloadKey, options = {}) {
  const payload = parseDownloadKey(downloadKey);

  const data = await extractProfileStoryGroupItems(
    {
      groupId: payload.groupId,
      username: payload.username,
      userId: payload.userId
    },
    options
  );

  const found = data.items.find(item => {
    return (
      String(item.id) === String(payload.itemId) ||
      Number(item.index) === Number(payload.index)
    );
  });

  if (!found?.downloadUrl) {
    throw new Error(
      "Không tìm thấy story item để tải. Có thể story đã hết hạn hoặc session không còn quyền xem."
    );
  }

  return found;
}

module.exports = {
  normalizeHighlightGroupId,
  getHighlightIdOnly,
  isActiveStoryGroupId,
  isHighlightGroupId,
  getStoryItemId,
  getCoverUrlFromMediaLike,
  getReelFromApiData,
  getTrayFromApiData,
  createContextForProfileRequest,
  fetchWebProfileInfo,
  fetchActiveStoryReel,
  fetchHighlightTray,
  fetchHighlightReel,
  storyItemToProfileOutput,
  reelItemsToOutput,
  extractProfileStoryGroups,
  extractProfileStoryGroupItems,
  resolveProfileDownloadItem
};