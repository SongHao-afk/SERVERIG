const express = require("express");

const { getIgCookieFromReq } = require("../utils/cookie");
const {
  extractProfileStoryGroups,
  extractProfileStoryGroupItems,
  resolveProfileDownloadItem
} = require("../instagram/profile");
const {
  fetchProfilePosts,
  fetchProfileReels,
  fetchProfileMediaItems
} = require("../instagram/profile-feed");
const { streamMediaUrlToResponse } = require("../services/download.service");

const router = express.Router();

function normalizeProfileUrl(input) {
  const clean = String(input || "").trim();

  if (!clean) return "";

  if (/^https?:\/\//i.test(clean)) {
    return clean;
  }

  const username = clean
    .replace(/^@/, "")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");

  if (!username) return "";

  return `https://www.instagram.com/${username}/`;
}

function getProfileUrlFromReq(req) {
  return normalizeProfileUrl(
    req.body?.profileUrl ||
      req.body?.url ||
      req.body?.username ||
      ""
  );
}

function getLimitFromReq(req, fallback = 12) {
  const raw = Number(req.body?.limit || fallback);

  if (!Number.isFinite(raw)) return fallback;

  return Math.max(1, Math.min(raw, 30));
}

// =========================
// STORY / HIGHLIGHT GROUPS
// =========================

router.post("/story-groups", async (req, res) => {
  try {
    const profileUrl = getProfileUrlFromReq(req);
    const igCookie = getIgCookieFromReq(req);

    if (!profileUrl) {
      return res.status(400).json({
        success: false,
        error: "Thiếu profileUrl"
      });
    }

    const data = await extractProfileStoryGroups(profileUrl, {
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

router.post("/story-group-items", async (req, res) => {
  try {
    const { groupId, username, userId, profileUrl } = req.body || {};
    const igCookie = getIgCookieFromReq(req);

    const safeUsername = username || profileUrl || "";

    if (!groupId) {
      return res.status(400).json({
        success: false,
        error: "Thiếu groupId"
      });
    }

    const data = await extractProfileStoryGroupItems(
      {
        groupId,
        username: safeUsername,
        userId
      },
      {
        igCookie
      }
    );

    res.json(data);
  } catch (err) {
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

router.post("/download-story-item", async (req, res) => {
  try {
    const { downloadKey } = req.body || {};
    const igCookie = getIgCookieFromReq(req);

    if (!downloadKey) {
      return res.status(400).send("Thiếu downloadKey");
    }

    const item = await resolveProfileDownloadItem(downloadKey, {
      igCookie
    });

    await streamMediaUrlToResponse(res, item.downloadUrl, igCookie);
  } catch (err) {
    res.status(500).send(err.message);
  }
});

// =========================
// PROFILE REELS MODE
// =========================

router.post("/reels", async (req, res) => {
  try {
    const profileUrl = getProfileUrlFromReq(req);
    const cursor = String(req.body?.cursor || "").trim();
    const limit = getLimitFromReq(req, 30);
    const igCookie = getIgCookieFromReq(req);

    if (!profileUrl) {
      return res.status(400).json({
        success: false,
        error: "Thiếu profileUrl"
      });
    }

    const data = await fetchProfileReels(profileUrl, {
      igCookie,
      cursor,
      limit
    });

    res.json(data);
  } catch (err) {
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

router.post("/posts", async (req, res) => {
  try {
    const profileUrl = getProfileUrlFromReq(req);
    const cursor = String(req.body?.cursor || "").trim();
    const limit = getLimitFromReq(req, 30);
    const igCookie = getIgCookieFromReq(req);

    if (!profileUrl) {
      return res.status(400).json({
        success: false,
        error: "Thiếu profileUrl"
      });
    }

    const data = await fetchProfilePosts(profileUrl, {
      igCookie,
      cursor,
      limit
    });

    res.json(data);
  } catch (err) {
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});
// =========================
// CLICK 1 REEL / POST ĐỂ LẤY ITEM CON
// =========================

router.post("/media-items", async (req, res) => {
  try {
    const { kind, shortcode, code, url } = req.body || {};
    const igCookie = getIgCookieFromReq(req);

    const data = await fetchProfileMediaItems(
      {
        kind,
        shortcode,
        code,
        url
      },
      {
        igCookie
      }
    );

    res.json(data);
  } catch (err) {
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

// =========================
// TẢI ITEM REEL / POST BẰNG downloadUrl
// Flutter có thể dùng route này thay vì GET /download?url=...
// =========================

router.post("/download-media-item", async (req, res) => {
  try {
    const { downloadUrl } = req.body || {};
    const igCookie = getIgCookieFromReq(req);

    if (!downloadUrl) {
      return res.status(400).send("Thiếu downloadUrl");
    }

    await streamMediaUrlToResponse(res, downloadUrl, igCookie);
  } catch (err) {
    res.status(500).send(err.message);
  }
});

module.exports = router;