const {
  isInstagramStoryUrl,
  isInstagramHighlightStoryUrl,
  getInstagramShortcode,
  getInstagramStoryPk
} = require("../utils/ig-url");

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
      (obj.image_versions2 ||
        obj.video_versions ||
        Array.isArray(obj.carousel_media))
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

      if (obj && String(obj.pk) === String(storyPk) && hasMediaShape(obj)) {
        return obj;
      }
    } catch {}
  }

  return null;
}

function findFirstMediaObject(html) {
  const needles = ["\"video_versions\"", "\"image_versions2\"", "\"carousel_media\""];
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

module.exports = {
  cleanIgUrl,
  pickBestImage,
  pickBestVideo,
  isRealPostImageUrl,
  getBestThumbnailUrl,
  extractJsonObjectAt,
  hasMediaShape,
  findMediaObjectByShortcode,
  findStoryObjectByPk,
  findFirstMediaObject,
  imageItemToOutput,
  mediaItemToOutput,
  extractMediaFromHtml
};