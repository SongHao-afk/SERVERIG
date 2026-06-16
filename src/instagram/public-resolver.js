const { chromium } = require("playwright");

const PUBLIC_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

function cleanUrl(value) {
  return String(value || "")
    .replaceAll("\\u0026", "&")
    .replaceAll("\\/", "/")
    .replaceAll("&amp;", "&");
}

function isInstagramCdn(url) {
  return (
    url.includes("cdninstagram.com") ||
    url.includes("fbcdn.net") ||
    url.includes("scontent")
  );
}

function looksLikeVideo(url) {
  return (
    url.includes(".mp4") ||
    url.includes("video_dashinit") ||
    url.includes("/o1/v/")
  );
}

function looksLikeImage(url) {
  return (
    url.includes(".jpg") ||
    url.includes(".jpeg") ||
    url.includes(".webp") ||
    url.includes(".png")
  );
}

function uniqueNonEmpty(list) {
  return [...new Set(list.map(cleanUrl).filter(Boolean))];
}

function pickBestVideo(candidates) {
  return (
    uniqueNonEmpty(candidates).find(
      (url) => isInstagramCdn(url) && looksLikeVideo(url)
    ) || ""
  );
}

function pickBestImage(candidates) {
  return (
    uniqueNonEmpty(candidates).find(
      (url) => isInstagramCdn(url) && looksLikeImage(url)
    ) || ""
  );
}

async function collectPublicPageMedia(page) {
  return await page.evaluate(() => {
    function cleanUrl(value) {
      return String(value || "")
        .replaceAll("\\u0026", "&")
        .replaceAll("\\/", "/")
        .replaceAll("&amp;", "&");
    }

    function meta(prop) {
      return (
        document.querySelector(`meta[property="${prop}"]`)?.content ||
        document.querySelector(`meta[name="${prop}"]`)?.content ||
        ""
      );
    }

    const metas = {
      ogTitle: cleanUrl(meta("og:title")),
      ogDescription: cleanUrl(meta("og:description")),
      ogImage: cleanUrl(meta("og:image")),
      ogVideo: cleanUrl(meta("og:video")),
      ogVideoSecure: cleanUrl(meta("og:video:secure_url")),
      twitterImage: cleanUrl(meta("twitter:image")),
      twitterPlayer: cleanUrl(meta("twitter:player")),
    };

    const videos = [...document.querySelectorAll("video")].map((v) => ({
      src: cleanUrl(v.currentSrc || v.src || ""),
      poster: cleanUrl(v.poster || ""),
      width: v.videoWidth || 0,
      height: v.videoHeight || 0,
      duration: Number.isFinite(v.duration) ? v.duration : null,
      readyState: v.readyState,
    }));

    const images = [...document.querySelectorAll("img")]
      .map((img) => {
        const rect = img.getBoundingClientRect();
        const width = img.naturalWidth || Math.round(rect.width) || 0;
        const height = img.naturalHeight || Math.round(rect.height) || 0;

        return {
          src: cleanUrl(img.currentSrc || img.src || ""),
          width,
          height,
          area: width * height,
          alt: img.alt || "",
        };
      })
      .filter(
        (x) =>
          x.src.includes("fbcdn") ||
          x.src.includes("cdninstagram") ||
          x.src.includes("scontent")
      )
      .filter((x) => x.width >= 300 && x.height >= 300)
      .sort((a, b) => b.area - a.area);

    const html = cleanUrl(document.documentElement.innerHTML);

    const mp4FromHtml = [
      ...new Set(html.match(/https?:\/\/[^"'<>\\\s]+?\.mp4[^"'<>\\\s]*/g) || []),
    ].slice(0, 30);

    const imageFromHtml = [
      ...new Set(
        html.match(/https?:\/\/[^"'<>\\\s]+?\.(jpg|jpeg|webp)[^"'<>\\\s]*/g) ||
          []
      ),
    ].slice(0, 30);

    return {
      metas,
      videos,
      images,
      mp4FromHtml,
      imageFromHtml,
    };
  });
}

async function tryStartVideo(page) {
  await page
    .evaluate(() => {
      const video = document.querySelector("video");

      if (video) {
        video.muted = true;
        video.play().catch(() => {});
      }

      const buttons = [...document.querySelectorAll("button")];

      const playButton = buttons.find((btn) => {
        const label = `${btn.getAttribute("aria-label") || ""} ${
          btn.innerText || ""
        }`.toLowerCase();

        return (
          label.includes("play") ||
          label.includes("phát") ||
          label.includes("reproducir")
        );
      });

      if (playButton) {
        playButton.click();
      }
    })
    .catch(() => {});
}

async function resolvePublicMedia(igUrl) {
  let browser = null;
  let context = null;
  let page = null;

  const responseMedia = [];

  try {
    browser = await chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
      ],
    });

    context = await browser.newContext({
      userAgent: PUBLIC_UA,
      locale: "vi-VN",
      viewport: {
        width: 1365,
        height: 900,
      },
    });

    page = await context.newPage();

    page.on("response", async (res) => {
      try {
        const url = cleanUrl(res.url());
        const headers = res.headers();
        const contentType = headers["content-type"] || "";
        const resourceType = res.request().resourceType();

        const isMedia =
          resourceType === "media" ||
          contentType.startsWith("video/") ||
          contentType.startsWith("image/") ||
          looksLikeVideo(url) ||
          looksLikeImage(url);

        if (!isInstagramCdn(url) || !isMedia) return;

        responseMedia.push({
          url,
          contentType,
          resourceType,
          time: Date.now(),
        });
      } catch {}
    });

    await page.goto(igUrl, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });

    await page.waitForTimeout(2200);
    await tryStartVideo(page);
    await page.waitForTimeout(2000);

    const pageMedia = await collectPublicPageMedia(page);

    const responseVideos = responseMedia
      .filter(
        (x) =>
          x.resourceType === "media" ||
          x.contentType.startsWith("video/") ||
          looksLikeVideo(x.url)
      )
      .map((x) => x.url)
      .reverse();

    const responseImages = responseMedia
      .filter((x) => x.contentType.startsWith("image/") || looksLikeImage(x.url))
      .map((x) => x.url)
      .reverse();

    const videoUrl = pickBestVideo([
      ...responseVideos,
      pageMedia.metas.ogVideo,
      pageMedia.metas.ogVideoSecure,
      ...pageMedia.videos.map((x) => x.src),
      ...pageMedia.mp4FromHtml,
    ]);

    const posterUrl = pickBestImage([
      pageMedia.metas.ogImage,
      pageMedia.metas.twitterImage,
      ...pageMedia.videos.map((x) => x.poster),
      ...pageMedia.images.map((x) => x.src),
      ...responseImages,
      ...pageMedia.imageFromHtml,
    ]);

    if (videoUrl) {
      const domVideo =
        pageMedia.videos.find((x) => cleanUrl(x.src) === videoUrl) || null;

      return [
        {
          type: "video",
          width: domVideo?.width || null,
          height: domVideo?.height || null,
          duration: domVideo?.duration || null,
          downloadUrl: videoUrl,
          thumbnailUrl: posterUrl || null,
        },
      ];
    }

    const imageUrl = pickBestImage([
      pageMedia.metas.ogImage,
      pageMedia.metas.twitterImage,
      ...pageMedia.images.map((x) => x.src),
      ...responseImages,
      ...pageMedia.imageFromHtml,
    ]);

    if (imageUrl) {
      const domImage =
        pageMedia.images.find((x) => cleanUrl(x.src) === imageUrl) || null;

      return [
        {
          type: "image",
          width: domImage?.width || null,
          height: domImage?.height || null,
          duration: null,
          downloadUrl: imageUrl,
          thumbnailUrl: imageUrl,
        },
      ];
    }

    return [];
  } finally {
    if (page) {
      await page.close().catch(() => {});
    }

    if (context) {
      await context.close().catch(() => {});
    }

    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}

module.exports = {
  resolvePublicMedia,
};