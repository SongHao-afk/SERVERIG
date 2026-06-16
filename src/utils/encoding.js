function base64UrlEncode(text) {
  return Buffer.from(String(text), "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function base64UrlDecode(text) {
  let value = String(text || "")
    .replace(/-/g, "+")
    .replace(/_/g, "/");

  while (value.length % 4 !== 0) {
    value += "=";
  }

  return Buffer.from(value, "base64").toString("utf8");
}

function makeDownloadKey(payload) {
  return base64UrlEncode(JSON.stringify(payload));
}

function parseDownloadKey(downloadKey) {
  try {
    const payload = JSON.parse(base64UrlDecode(downloadKey));

    if (!payload || typeof payload !== "object") {
      throw new Error("Payload rỗng");
    }

    if (!payload.kind || !payload.groupId || !payload.itemId) {
      throw new Error("Payload thiếu kind/groupId/itemId");
    }

    return payload;
  } catch {
    throw new Error("downloadKey không hợp lệ hoặc đã bị sửa");
  }
}

module.exports = {
  base64UrlEncode,
  base64UrlDecode,
  makeDownloadKey,
  parseDownloadKey
};