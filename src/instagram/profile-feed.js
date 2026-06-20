const { normalizeIgCookie } = require("../utils/cookie");
const { extractInstagramUsername } = require("../utils/ig-url");
const {
  createContextForProfileRequest,
  fetchWebProfileInfo
} = require("./profile");
const { prepareInstagramApiPage } = require("./page");
const { igApiJson, igApiPostJson } = require("./api");
const { extractInstagramMedia } = require("./html-resolver");

const DEFAULT_PROFILE_FEED_LIMIT = 30;
const MAX_PROFILE_FEED_LIMIT = 30;

function getSafeFeedLimit(value) {
  const parsed = Number(value ?? DEFAULT_PROFILE_FEED_LIMIT);

  if (!Number.isFinite(parsed)) {
    return DEFAULT_PROFILE_FEED_LIMIT;
  }

  return Math.max(1, Math.min(Math.floor(parsed), MAX_PROFILE_FEED_LIMIT));
}

function cleanUrl(url) {
  if (!url) return null;

  return String(url).replace(/\\u0026/g, "&");
}

function pickBestCandidate(candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return null;
  }

  const sorted = [...candidates].sort((a, b) => {
    const aw = Number(a?.width || 0);
    const bw = Number(b?.width || 0);
    return bw - aw;
  });

  return cleanUrl(sorted[0]?.url);
}

function pickBestVideoVersion(media) {
  const versions = Array.isArray(media?.video_versions)
    ? media.video_versions
    : [];

  if (versions.length === 0) {
    return null;
  }

  return [...versions].sort((a, b) => {
    const aw = Number(a?.width || 0);
    const ah = Number(a?.height || 0);
    const bw = Number(b?.width || 0);
    const bh = Number(b?.height || 0);

    const aScore = aw * ah || aw;
    const bScore = bw * bh || bw;

    return bScore - aScore;
  })[0];
}

function getApiImageUrl(media) {
  return (
    pickBestCandidate(media?.image_versions2?.candidates) ||
    cleanUrl(media?.thumbnail_url) ||
    cleanUrl(media?.display_url) ||
    null
  );
}

function getApiCaption(media) {
  if (typeof media?.caption === "string") return media.caption;
  if (typeof media?.caption?.text === "string") return media.caption.text;

  return "";
}

function getApiShortcode(media) {
  return String(
    media?.code ||
      media?.shortcode ||
      media?.media_code ||
      ""
  );
}

function getApiId(media, fallback = null) {
  return String(media?.pk || media?.id || media?.code || media?.shortcode || fallback || "");
}

function normalizeProductType(media) {
  return String(media?.product_type || media?.media_type || "").toLowerCase();
}

function getMediaKindFromApi(media) {
  const productType = normalizeProductType(media);
  const mediaType = Number(media?.media_type || 0);

  if (productType === "clips") return "reel";

  // Instagram API:
  // 1 = image
  // 2 = video
  // 8 = carousel
  if (mediaType === 8) return "carousel";
  if (mediaType === 2) return "video";

  return "image";
}

function normalizePostApiMedia(media, index) {
  const shortcode = getApiShortcode(media);

  if (!shortcode) return null;

  const kind = getMediaKindFromApi(media);

  // /profile/posts chỉ lấy post ảnh/video/carousel, không lấy reel clips
  if (kind === "reel") return null;

  const carouselItems = Array.isArray(media?.carousel_media)
    ? media.carousel_media
    : [];

  const itemCount = kind === "carousel" ? carouselItems.length : 1;

  return {
    id: shortcode,
    index,
    kind: "post",
    type: kind,
    shortcode,
    url: `https://www.instagram.com/p/${shortcode}/`,
    coverUrl: getApiImageUrl(media),
    caption: getApiCaption(media),
    takenAt: media?.taken_at || media?.taken_at_timestamp || null,
    itemCount,
    likeCount: media?.like_count || null,
    commentCount: media?.comment_count || null
  };
}

function normalizeReelApiMedia(media, index) {
  const shortcode = getApiShortcode(media);
  const coverUrl = getApiImageUrl(media);
  const bestVideo = pickBestVideoVersion(media);
  const downloadUrl = cleanUrl(bestVideo?.url || bestVideo?.src);

  // Reel có video_versions thì trả thẳng downloadUrl.
  // Nếu thiếu downloadUrl nhưng có shortcode thì vẫn giữ fallback cho /profile/media-items.
  if (!downloadUrl && !shortcode) return null;

  return {
    id: shortcode || getApiId(media, index),
    index,
    kind: "reel",
    type: "video",
    shortcode: shortcode || null,
    url: shortcode ? `https://www.instagram.com/reel/${shortcode}/` : null,
    coverUrl,
    thumbnailUrl: coverUrl,
    downloadUrl,
    canDownload: Boolean(downloadUrl),
    needsResolve: !downloadUrl && Boolean(shortcode),
    width: Number(bestVideo?.width || media?.original_width || 0) || null,
    height: Number(bestVideo?.height || media?.original_height || 0) || null,
    duration: Number(media?.video_duration || media?.duration || 0) || null,
    caption: getApiCaption(media),
    takenAt: media?.taken_at || media?.taken_at_timestamp || null,
    itemCount: 1,
    likeCount: media?.like_count || null,
    commentCount: media?.comment_count || null,
    viewCount: media?.play_count || media?.view_count || null
  };
}

function getFeedItemsFromApi(data) {
  if (Array.isArray(data?.items)) return data.items;

  if (Array.isArray(data?.feed_items)) {
    return data.feed_items
      .map(x => x?.media_or_ad || x?.media || x?.item || x)
      .filter(Boolean);
  }

  return [];
}

function getFeedPageInfo(data) {
  return {
    hasNextPage: Boolean(
      data?.more_available ||
        data?.paging_info?.more_available ||
        data?.has_more
    ),
    nextCursor:
      data?.next_max_id ||
      data?.max_id ||
      data?.paging_info?.max_id ||
      null
  };
}

function getClipsItemsFromApi(data) {
  const rawItems =
    data?.items ||
    data?.clips ||
    data?.reels ||
    data?.media ||
    [];

  if (!Array.isArray(rawItems)) return [];

  return rawItems
    .map(item => item?.media || item?.item || item)
    .filter(Boolean);
}

function getClipsPageInfo(data) {
  return {
    hasNextPage: Boolean(
      data?.paging_info?.more_available ||
        data?.more_available ||
        data?.has_more
    ),
    nextCursor:
      data?.paging_info?.max_id ||
      data?.next_max_id ||
      data?.max_id ||
      null
  };
}

async function openProfilePage(profileUrl, igCookie) {
  const username = extractInstagramUsername(profileUrl);

  let page = null;
  let privateBrowser = null;

  const requestContext = await createContextForProfileRequest(igCookie);
  privateBrowser = requestContext.privateBrowser;

  page = await requestContext.context.newPage();

  await prepareInstagramApiPage(page, username, igCookie);

  const profile = await fetchWebProfileInfo(page, username);

  return {
    username,
    requestContext,
    privateBrowser,
    page,
    profile
  };
}

async function fetchProfilePosts(profileUrl, options = {}) {
  const igCookie = normalizeIgCookie(options.igCookie || "");
  const limit = getSafeFeedLimit(options.limit);
  const cursor = String(options.cursor || "").trim();

  let page = null;
  let privateBrowser = null;

  try {
    const opened = await openProfilePage(profileUrl, igCookie);

    page = opened.page;
    privateBrowser = opened.privateBrowser;

    const { requestContext, profile } = opened;

    if (!profile.userId) {
      throw new Error("Không lấy được userId của profile");
    }

    const params = new URLSearchParams({
      count: String(limit)
    });

    if (cursor) {
      params.set("max_id", cursor);
    }

    console.log("[PROFILE POSTS API]", {
      username: profile.username,
      userId: profile.userId,
      limit,
      cursor,
      api: `/api/v1/feed/user/${profile.userId}/?${params.toString()}`
    });

    const data = await igApiJson(
      page,
      `/api/v1/feed/user/${profile.userId}/?${params.toString()}`
    );

    const rawItems = getFeedItemsFromApi(data);
    const pageInfo = getFeedPageInfo(data);

    const items = rawItems
      .map((media, index) => normalizePostApiMedia(media, index + 1))
      .filter(Boolean);

    console.log("[PROFILE POSTS RESULT]", {
      rawLength: rawItems.length,
      itemLength: items.length,
      hasNextPage: pageInfo.hasNextPage,
      nextCursor: pageInfo.nextCursor
    });

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
      kind: "posts",
      total: items.length,
      hasNextPage: pageInfo.hasNextPage,
      nextCursor: pageInfo.nextCursor,
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

async function fetchProfileReels(profileUrl, options = {}) {
  const igCookie = normalizeIgCookie(options.igCookie || "");
  const limit = getSafeFeedLimit(options.limit);
  const cursor = String(options.cursor || "").trim();

  let page = null;
  let privateBrowser = null;

  try {
    const opened = await openProfilePage(profileUrl, igCookie);

    page = opened.page;
    privateBrowser = opened.privateBrowser;

    const { requestContext, profile } = opened;

    if (!profile.userId) {
      throw new Error("Không lấy được userId của profile");
    }

    const form = {
      target_user_id: profile.userId,
      page_size: String(limit),
      include_feed_video: "true"
    };

    if (cursor) {
      form.max_id = cursor;
    }

    console.log("[PROFILE REELS API]", {
      username: profile.username,
      userId: profile.userId,
      limit,
      cursor,
      form
    });

    const data = await igApiPostJson(
      page,
      "/api/v1/clips/user/",
      form
    );

    const medias = getClipsItemsFromApi(data);
    const pageInfo = getClipsPageInfo(data);

    const items = medias
      .map((media, index) => normalizeReelApiMedia(media, index + 1))
      .filter(Boolean);

    console.log("[PROFILE REELS RESULT]", {
      rawLength: medias.length,
      itemLength: items.length,
      hasNextPage: pageInfo.hasNextPage,
      nextCursor: pageInfo.nextCursor
    });

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
      kind: "reels",
      total: items.length,
      hasNextPage: pageInfo.hasNextPage,
      nextCursor: pageInfo.nextCursor,
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

function normalizeKind(kind) {
  const clean = String(kind || "").trim().toLowerCase();

  if (clean === "reels") return "reel";
  if (clean === "clips") return "reel";
  if (clean === "posts") return "post";
  if (clean === "image") return "post";
  if (clean === "photo") return "post";

  return clean;
}

function getMediaUrlFromInput(params = {}) {
  const directUrl = String(params.url || "").trim();

  if (directUrl) return directUrl;

  const kind = normalizeKind(params.kind);
  const shortcode = String(params.shortcode || params.code || "").trim();

  if (!shortcode) {
    throw new Error("Thiếu shortcode hoặc url");
  }

  if (kind === "reel") {
    return `https://www.instagram.com/reel/${shortcode}/`;
  }

  if (kind === "post") {
    return `https://www.instagram.com/p/${shortcode}/`;
  }

  throw new Error("kind phải là reel hoặc post");
}

async function fetchProfileMediaItems(params = {}, options = {}) {
  const igCookie = normalizeIgCookie(options.igCookie || "");
  const sourceUrl = getMediaUrlFromInput(params);

  const data = await extractInstagramMedia(sourceUrl, {
    igCookie
  });

  const media = Array.isArray(data.media) ? data.media : [];

  return {
    success: true,
    mode: data.mode,
    kind: normalizeKind(params.kind) || "media",
    source: sourceUrl,
    mediaKey: data.mediaKey,
    total: media.length,
    items: media.map((item, index) => ({
      id: item.id || index + 1,
      index: index + 1,
      type: item.type || "image",
      width: item.width || null,
      height: item.height || null,
      duration: item.duration || null,
      thumbnailUrl:
        item.thumbnailUrl ||
        (item.type === "image" ? item.downloadUrl : null),
      downloadUrl: item.downloadUrl
    }))
  };
}

module.exports = {
  fetchProfilePosts,
  fetchProfileReels,
  fetchProfileMediaItems
};