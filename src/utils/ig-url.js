const MEDIA_TYPES = new Set(["p", "reel", "tv"]);

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

function getPathParts(url) {
  const u = new URL(url);
  return u.pathname.split("/").filter(Boolean);
}

function isInstagramStoryUrl(url) {
  try {
    const parts = getPathParts(url);
    const first = parts[0];

    return first === "stories" || first === "s";
  } catch {
    return false;
  }
}

function isInstagramHighlightStoryUrl(url) {
  try {
    const parts = getPathParts(url);
    const first = parts[0];

    return first === "s";
  } catch {
    return false;
  }
}

function getInstagramShortcode(url) {
  try {
    const parts = getPathParts(url);

    // Hỗ trợ:
    // /p/CODE/
    // /reel/CODE/
    // /tv/CODE/
    // /username/p/CODE/
    // /username/reel/CODE/
    // /username/tv/CODE/
    for (let i = 0; i < parts.length - 1; i++) {
      const type = parts[i];
      const code = parts[i + 1];

      if (MEDIA_TYPES.has(type) && code) {
        return code;
      }
    }

    return "";
  } catch {
    return "";
  }
}

function normalizeInstagramMediaUrl(url) {
  try {
    if (!isInstagramUrl(url)) return String(url || "");

    const u = new URL(url);
    const parts = u.pathname.split("/").filter(Boolean);

    // Giữ nguyên story/highlight vì route story khác post/reel.
    if (parts[0] === "stories" || parts[0] === "s") {
      return u.toString();
    }

    for (let i = 0; i < parts.length - 1; i++) {
      const type = parts[i];
      const code = parts[i + 1];

      if (MEDIA_TYPES.has(type) && code) {
        return `https://www.instagram.com/${type}/${code}/`;
      }
    }

    return u.toString();
  } catch {
    return String(url || "");
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

function extractInstagramUsername(input) {
  const raw = String(input || "").trim();

  if (!raw) {
    throw new Error("Thiếu profileUrl hoặc username");
  }

  let value = raw.replace(/^@+/, "").trim();

  if (!/^https?:\/\//i.test(value)) {
    value = value.split(/[/?#]/)[0].trim();

    if (!/^[A-Za-z0-9._]{1,30}$/.test(value)) {
      throw new Error("Username Instagram không hợp lệ");
    }

    return value;
  }

  let u = null;

  try {
    u = new URL(value);
  } catch {
    throw new Error("Profile URL không hợp lệ");
  }

  if (!isInstagramUrl(value)) {
    throw new Error("URL không phải Instagram");
  }

  const parts = u.pathname.split("/").filter(Boolean);
  const username = parts[0] || "";

  const blockedFirstSegments = new Set([
    "p",
    "reel",
    "tv",
    "stories",
    "s",
    "explore",
    "accounts",
    "direct",
    "about",
    "developer",
  ]);

  if (!username || blockedFirstSegments.has(username)) {
    throw new Error("Link này không phải link trang cá nhân Instagram");
  }

  if (!/^[A-Za-z0-9._]{1,30}$/.test(username)) {
    throw new Error("Không lấy được username từ profile URL");
  }

  return username;
}

function isAllowedInstagramMediaHost(hostname) {
  return hostname.includes("fbcdn.net") || hostname.includes("cdninstagram.com");
}

module.exports = {
  isInstagramUrl,
  isInstagramStoryUrl,
  isInstagramHighlightStoryUrl,
  getInstagramShortcode,
  normalizeInstagramMediaUrl,
  getInstagramStoryPk,
  extractInstagramUsername,
  isAllowedInstagramMediaHost,
};