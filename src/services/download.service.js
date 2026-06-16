const { nanoid } = require("nanoid");

const { MOBILE_UA } = require("../config");
const { isAllowedInstagramMediaHost } = require("../utils/ig-url");

async function streamMediaUrlToResponse(res, mediaUrl, igCookie = "") {
  if (!mediaUrl) {
    return res.status(400).send("Thiếu url");
  }

  const u = new URL(mediaUrl);

  if (!isAllowedInstagramMediaHost(u.hostname)) {
    return res.status(400).send("Chỉ cho tải media từ Instagram CDN");
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
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);

  const arrayBuffer = await response.arrayBuffer();

  return res.send(Buffer.from(arrayBuffer));
}

module.exports = {
  streamMediaUrlToResponse
};