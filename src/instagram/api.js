async function igApiJson(page, pathOrUrl) {
  const result = await page.evaluate(async ({ pathOrUrl }) => {
    function getCookieValue(name) {
      const cookies = document.cookie
        .split(";")
        .map(x => x.trim())
        .filter(Boolean);

      for (const cookie of cookies) {
        const eqIndex = cookie.indexOf("=");

        if (eqIndex === -1) continue;

        const cookieName = cookie.slice(0, eqIndex);

        if (cookieName === name) {
          return decodeURIComponent(cookie.slice(eqIndex + 1));
        }
      }

      return "";
    }

    const response = await fetch(pathOrUrl, {
      method: "GET",
      credentials: "include",
      headers: {
        accept: "application/json, text/plain, */*",
        "x-ig-app-id": "936619743392459",
        "x-asbd-id": "129477",
        "x-csrftoken": getCookieValue("csrftoken"),
        "x-requested-with": "XMLHttpRequest"
      }
    });

    const text = await response.text();

    return {
      ok: response.ok,
      status: response.status,
      url: response.url,
      text
    };
  }, { pathOrUrl });

  if (!result.ok) {
    throw new Error(
      `Instagram API lỗi ${result.status}: ${result.text.slice(0, 180)}`
    );
  }

  try {
    return JSON.parse(result.text);
  } catch {
    throw new Error(
      `Instagram API không trả JSON hợp lệ: ${result.text.slice(0, 180)}`
    );
  }
}

async function igApiPostJson(page, pathOrUrl, form = {}) {
  const result = await page.evaluate(async ({ pathOrUrl, form }) => {
    function getCookieValue(name) {
      const cookies = document.cookie
        .split(";")
        .map(x => x.trim())
        .filter(Boolean);

      for (const cookie of cookies) {
        const eqIndex = cookie.indexOf("=");

        if (eqIndex === -1) continue;

        const cookieName = cookie.slice(0, eqIndex);

        if (cookieName === name) {
          return decodeURIComponent(cookie.slice(eqIndex + 1));
        }
      }

      return "";
    }

    const body = new URLSearchParams();

    for (const [key, value] of Object.entries(form || {})) {
      if (value === undefined || value === null) continue;

      const cleanValue = String(value);

      if (cleanValue.trim() === "") continue;

      body.set(key, cleanValue);
    }

    const response = await fetch(pathOrUrl, {
      method: "POST",
      credentials: "include",
      headers: {
        accept: "application/json, text/plain, */*",
        "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
        "x-ig-app-id": "936619743392459",
        "x-asbd-id": "129477",
        "x-csrftoken": getCookieValue("csrftoken"),
        "x-requested-with": "XMLHttpRequest",
        "x-instagram-ajax": "1"
      },
      body: body.toString()
    });

    const text = await response.text();

    return {
      ok: response.ok,
      status: response.status,
      url: response.url,
      text
    };
  }, { pathOrUrl, form });

  if (!result.ok) {
    throw new Error(
      `Instagram API POST lỗi ${result.status}: ${result.text.slice(0, 180)}`
    );
  }

  try {
    return JSON.parse(result.text);
  } catch {
    throw new Error(
      `Instagram API POST không trả JSON hợp lệ: ${result.text.slice(0, 180)}`
    );
  }
}

module.exports = {
  igApiJson,
  igApiPostJson
};