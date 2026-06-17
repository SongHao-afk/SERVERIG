const { chromium } = require("playwright");
const { closeInstagramPopups } = require("./page");

const PUBLIC_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const PUBLIC_CACHE_TTL_MS = 5 * 60 * 1000;
const PAGE_TIMEOUT_MS = 45000;
const MAX_PUBLIC_CAROUSEL_STEPS = 20;

let publicBrowser = null;
let publicBrowserPromise = null;

const publicCache = new Map();
const inflightPublicResolve = new Map();

function cleanUrl(value) {
  return String(value || "")
    .replaceAll("\\u0026", "&")
    .replaceAll("\\/", "/")
    .replaceAll("&amp;", "&");
}

function cloneMedia(items) {
  return JSON.parse(JSON.stringify(items || []));
}

function getCache(key) {
  const hit = publicCache.get(key);

  if (!hit) return null;

  if (Date.now() > hit.expiresAt) {
    publicCache.delete(key);
    return null;
  }

  return cloneMedia(hit.value);
}

function setCache(key, value, ttlMs = PUBLIC_CACHE_TTL_MS) {
  if (!Array.isArray(value) || value.length === 0) return;

  publicCache.set(key, {
    value: cloneMedia(value),
    expiresAt: Date.now() + ttlMs,
  });
}

async function runOncePerKey(key, fn) {
  if (inflightPublicResolve.has(key)) {
    console.log(`⏳ PUBLIC WAIT SAME LINK | key=${key}`);
    return await inflightPublicResolve.get(key);
  }

  const promise = fn().finally(() => {
    inflightPublicResolve.delete(key);
  });

  inflightPublicResolve.set(key, promise);
  return await promise;
}

async function getPublicBrowser() {
  if (publicBrowser && publicBrowser.isConnected()) {
    return publicBrowser;
  }

  if (!publicBrowserPromise) {
    publicBrowserPromise = chromium
      .launch({
        headless: true,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-gpu",
          "--disable-extensions",
          "--disable-background-networking",
          "--disable-sync",
          "--metrics-recording-only",
          "--mute-audio",
        ],
      })
      .then((browser) => {
        publicBrowser = browser;

        browser.on("disconnected", () => {
          publicBrowser = null;
          publicBrowserPromise = null;
          console.warn("⚠️ Public no-login browser disconnected");
        });

        console.log("✅ Public no-login browser ready");

        return browser;
      })
      .catch((err) => {
        publicBrowser = null;
        publicBrowserPromise = null;
        throw err;
      });
  }

  return await publicBrowserPromise;
}

async function closePublicBrowser() {
  if (publicBrowser) {
    await publicBrowser.close().catch(() => {});
  }

  publicBrowser = null;
  publicBrowserPromise = null;
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

function isBadProfileImageUrl(url) {
  return (
    url.includes("/v/t51.2885-19/") ||
    url.includes("/v/t51.82787-19/") ||
    url.includes("/v/t51.12442-15/")
  );
}

function pickRecentVideo(responseMedia, afterTime = 0) {
  return (
    responseMedia
      .filter((x) => x.time >= afterTime)
      .filter(
        (x) =>
          x.resourceType === "media" ||
          x.contentType.startsWith("video/") ||
          looksLikeVideo(x.url)
      )
      .map((x) => x.url)
      .reverse()
      .find((url) => isInstagramCdn(url) && looksLikeVideo(url)) || ""
  );
}

function pickRecentImage(responseMedia, afterTime = 0) {
  return (
    responseMedia
      .filter((x) => x.time >= afterTime)
      .filter((x) => x.contentType.startsWith("image/") || looksLikeImage(x.url))
      .map((x) => x.url)
      .reverse()
      .find(
        (url) =>
          isInstagramCdn(url) &&
          looksLikeImage(url) &&
          !isBadProfileImageUrl(url)
      ) || ""
  );
}

async function closeGuestPopups(page) {
  await closeInstagramPopups(page).catch(() => {});

  await page
    .evaluate(() => {
      const texts = [
        "Not Now",
        "Not now",
        "Không phải bây giờ",
        "Để sau",
        "Cancel",
        "Hủy",
      ];

      const buttons = [...document.querySelectorAll("button")];

      for (const btn of buttons) {
        const text = (btn.innerText || btn.textContent || "").trim();

        if (texts.some((x) => text.includes(x))) {
          btn.click();
          return true;
        }
      }

      return false;
    })
    .catch(() => {});
}

async function waitPageReady(page) {
  await Promise.race([
    page.waitForSelector("article, main, video, img", { timeout: 1200 }).catch(() => null),
    page.waitForTimeout(1200),
  ]);

  await page.waitForTimeout(500);
  await closeGuestPopups(page);
  await page.waitForTimeout(250);
}

async function installFastRouteBlocker(page) {
  await page
    .route("**/*", async (route) => {
      const req = route.request();
      const type = req.resourceType();
      const url = req.url();

      const shouldBlock =
        type === "font" ||
        url.includes("google-analytics") ||
        url.includes("googletagmanager") ||
        url.includes("doubleclick") ||
        url.includes("facebook.com/tr");

      if (shouldBlock) {
        return route.abort().catch(() => {});
      }

      return route.continue().catch(() => {});
    })
    .catch(() => {});
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

async function getVisiblePostMedia(page) {
  return await page.evaluate(() => {
    const vw = window.innerWidth || document.documentElement.clientWidth || 0;
    const vh = window.innerHeight || document.documentElement.clientHeight || 0;

    function cleanUrl(value) {
      return String(value || "")
        .replaceAll("\\u0026", "&")
        .replaceAll("\\/", "/")
        .replaceAll("&amp;", "&");
    }

    function isInstagramCdn(src) {
      return (
        src.includes("cdninstagram.com") ||
        src.includes("fbcdn.net") ||
        src.includes("scontent") ||
        src.startsWith("blob:https://www.instagram.com/")
      );
    }

    function isBadProfileImage(src, alt) {
      const s = String(src || "");
      const a = String(alt || "").toLowerCase();

      return (
        s.includes("/v/t51.2885-19/") ||
        s.includes("/v/t51.82787-19/") ||
        a.includes("profile picture") ||
        a.includes("ảnh đại diện")
      );
    }

    function getRectScore(rect) {
      if (!rect) return 0;

      const area = rect.width * rect.height;
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;

      const inside =
        rect.width > 0 &&
        rect.height > 0 &&
        rect.bottom > 0 &&
        rect.right > 0 &&
        rect.top < vh &&
        rect.left < vw;

      if (!inside) return 0;

      const nearCenterX = 1 - Math.min(1, Math.abs(cx - vw / 2) / (vw / 2));
      const nearCenterY = 1 - Math.min(1, Math.abs(cy - vh / 2) / (vh / 2));

      return area * (0.6 + nearCenterX * 0.25 + nearCenterY * 0.15);
    }

    function visibleEnough(rect, minW, minH) {
      if (!rect) return false;

      return (
        rect.width >= minW &&
        rect.height >= minH &&
        rect.bottom > 0 &&
        rect.right > 0 &&
        rect.top < vh &&
        rect.left < vw
      );
    }

    const root =
      document.querySelector("article") ||
      document.querySelector("main") ||
      document.body;

    const videos = [...root.querySelectorAll("video")]
      .map((v, index) => {
        const rect = v.getBoundingClientRect();
        const src = cleanUrl(v.currentSrc || v.src || "");
        const poster = cleanUrl(v.poster || "");

        return {
          index,
          type: "video",
          src,
          poster,
          width: v.videoWidth || Math.round(rect.width) || null,
          height: v.videoHeight || Math.round(rect.height) || null,
          duration: Number.isFinite(v.duration) ? v.duration : null,
          rectWidth: Math.round(rect.width),
          rectHeight: Math.round(rect.height),
          score: getRectScore(rect),
          visible: visibleEnough(rect, 220, 220) && isInstagramCdn(src),
        };
      })
      .filter((x) => x.visible)
      .sort((a, b) => b.score - a.score);

    if (videos.length > 0) {
      return videos[0];
    }

    const images = [...root.querySelectorAll("img")]
      .map((img, index) => {
        const rect = img.getBoundingClientRect();
        const src = cleanUrl(img.currentSrc || img.src || "");

        const naturalWidth = img.naturalWidth || 0;
        const naturalHeight = img.naturalHeight || 0;
        const rectWidth = Math.round(rect.width) || 0;
        const rectHeight = Math.round(rect.height) || 0;

        return {
          index,
          type: "image",
          src,
          poster: "",
          width: naturalWidth || rectWidth || null,
          height: naturalHeight || rectHeight || null,
          duration: null,
          rectWidth,
          rectHeight,
          alt: img.alt || "",
          score: getRectScore(rect),
          visible:
            visibleEnough(rect, 260, 260) &&
            isInstagramCdn(src) &&
            !src.startsWith("blob:") &&
            !isBadProfileImage(src, img.alt || "") &&
            (naturalWidth >= 260 || rectWidth >= 260) &&
            (naturalHeight >= 260 || rectHeight >= 260),
        };
      })
      .filter((x) => x.visible)
      .sort((a, b) => b.score - a.score);

    if (images.length > 0) {
      return images[0];
    }

    return null;
  });
}

async function clickNextCarousel(page) {
  return await page
    .evaluate(() => {
      function isVisible(el) {
        const rect = el.getBoundingClientRect();

        return (
          rect.width > 0 &&
          rect.height > 0 &&
          rect.bottom > 0 &&
          rect.right > 0 &&
          rect.top < window.innerHeight &&
          rect.left < window.innerWidth
        );
      }

      const labels = [
        "next",
        "tiếp",
        "sau",
        "siguiente",
        "suivant",
        "avanti",
        "weiter",
      ];

      const buttons = [...document.querySelectorAll("button, [role='button']")];

      const labeled = buttons.find((btn) => {
        if (!isVisible(btn)) return false;

        const label = `${btn.getAttribute("aria-label") || ""} ${
          btn.innerText || btn.textContent || ""
        }`.toLowerCase();

        return labels.some((x) => label.includes(x));
      });

      if (labeled) {
        labeled.click();
        return true;
      }

      const vw = window.innerWidth || document.documentElement.clientWidth || 0;
      const vh = window.innerHeight || document.documentElement.clientHeight || 0;

      const rightButtons = buttons
        .map((btn) => {
          const rect = btn.getBoundingClientRect();

          return {
            btn,
            rect,
            visible: isVisible(btn),
          };
        })
        .filter((x) => {
          const rect = x.rect;

          return (
            x.visible &&
            rect.left > vw * 0.55 &&
            rect.top > vh * 0.15 &&
            rect.bottom < vh * 0.95 &&
            rect.width <= 90 &&
            rect.height <= 90
          );
        })
        .sort((a, b) => b.rect.right - a.rect.right);

      if (rightButtons.length > 0) {
        rightButtons[0].btn.click();
        return true;
      }

      return false;
    })
    .catch(() => false);
}

function normalizePublicItem(item, responseMedia, afterTime) {
  if (!item) return null;

  if (item.type === "video") {
    let videoUrl = cleanUrl(item.src || "");

    if (!videoUrl || videoUrl.startsWith("blob:")) {
      videoUrl = pickRecentVideo(responseMedia, afterTime);
    }

    if (!videoUrl) return null;

    let posterUrl = cleanUrl(item.poster || "");

    if (!posterUrl || posterUrl.startsWith("blob:")) {
      posterUrl = pickRecentImage(responseMedia, afterTime);
    }

    return {
      type: "video",
      width: item.width || null,
      height: item.height || null,
      duration: item.duration || null,
      downloadUrl: videoUrl,
      thumbnailUrl: posterUrl || null,
    };
  }

  if (item.type === "image") {
    const imageUrl = cleanUrl(item.src || "");

    if (!imageUrl || imageUrl.startsWith("blob:")) return null;
    if (!isInstagramCdn(imageUrl)) return null;
    if (isBadProfileImageUrl(imageUrl)) return null;

    return {
      type: "image",
      width: item.width || null,
      height: item.height || null,
      duration: null,
      downloadUrl: imageUrl,
      thumbnailUrl: imageUrl,
    };
  }

  return null;
}

async function resolvePublicPostByDom(page, igUrl, responseMedia) {
  await page.goto(igUrl, {
    waitUntil: "domcontentloaded",
    timeout: PAGE_TIMEOUT_MS,
  });

  await waitPageReady(page);

  const media = [];
  const seen = new Set();
  let staleCount = 0;

  for (let i = 0; i < MAX_PUBLIC_CAROUSEL_STEPS; i++) {
    const startedAt = Date.now();

    await tryStartVideo(page);
    await page.waitForTimeout(250);

    const visible = await getVisiblePostMedia(page);
    const item = normalizePublicItem(visible, responseMedia, startedAt - 2500);

    if (item && item.downloadUrl && !seen.has(item.downloadUrl)) {
      seen.add(item.downloadUrl);
      media.push(item);
      staleCount = 0;
    } else {
      staleCount++;
    }

    const clicked = await clickNextCarousel(page);

    if (!clicked) {
      break;
    }

    await page.waitForTimeout(550);

    if (staleCount >= 3) {
      break;
    }
  }

  return media;
}

async function resolvePublicReelByDom(page, igUrl, responseMedia) {
  await page.goto(igUrl, {
    waitUntil: "domcontentloaded",
    timeout: PAGE_TIMEOUT_MS,
  });

  await waitPageReady(page);

  const startedAt = Date.now();

  await tryStartVideo(page);
  await page.waitForTimeout(1200);

  const visible = await getVisiblePostMedia(page);
  const item = normalizePublicItem(visible, responseMedia, startedAt - 2500);

  if (item && item.type === "video" && item.downloadUrl) {
    return [item];
  }

  const videoUrl = pickRecentVideo(responseMedia, startedAt - 2500);
  const posterUrl = pickRecentImage(responseMedia, startedAt - 2500);

  if (!videoUrl) {
    return [];
  }

  return [
    {
      type: "video",
      width: null,
      height: null,
      duration: null,
      downloadUrl: videoUrl,
      thumbnailUrl: posterUrl || null,
    },
  ];
}

async function resolvePublicMediaFresh(igUrl) {
  let context = null;
  let page = null;

  const pathType = getMediaPathType(igUrl);
  const responseMedia = [];

  const browser = await getPublicBrowser();

  try {
    context = await browser.newContext({
      userAgent: PUBLIC_UA,
      locale: "vi-VN",
      viewport: {
        width: 1365,
        height: 900,
      },
    });

    page = await context.newPage();

    await installFastRouteBlocker(page);

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

    if (pathType === "p") {
      return await resolvePublicPostByDom(page, igUrl, responseMedia);
    }

    if (pathType === "reel") {
      return await resolvePublicReelByDom(page, igUrl, responseMedia);
    }

    return [];
  } finally {
    if (page) {
      await page.close().catch(() => {});
    }

    if (context) {
      await context.close().catch(() => {});
    }
  }
}

async function resolvePublicMedia(igUrl) {
  const cacheKey = cleanUrl(igUrl);
  const cached = getCache(cacheKey);

  if (cached) {
    console.log(`⚡ PUBLIC CACHE HIT | key=${getMediaPathType(igUrl)} | total=${cached.length}`);
    return cached;
  }

  return await runOncePerKey(cacheKey, async () => {
    const cachedAgain = getCache(cacheKey);

    if (cachedAgain) {
      console.log(
        `⚡ PUBLIC CACHE HIT | key=${getMediaPathType(igUrl)} | total=${cachedAgain.length}`
      );
      return cachedAgain;
    }

    const media = await resolvePublicMediaFresh(igUrl);

    if (media.length > 0) {
      setCache(cacheKey, media);
    }

    return media;
  });
}

module.exports = {
  resolvePublicMedia,
  closePublicBrowser,
};