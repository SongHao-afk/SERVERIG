const { PRIVATE_COOKIE_HEADER } = require("../config");

function normalizeIgCookie(cookie) {
  return String(cookie || "").trim();
}

function getIgCookieFromReq(req) {
  return normalizeIgCookie(
    req.headers[PRIVATE_COOKIE_HEADER] ||
      req.body?.igCookie ||
      req.body?.privateCookie ||
      ""
  );
}

function parseCookieString(cookieString) {
  const ignoredNames = new Set([
    "path",
    "domain",
    "expires",
    "max-age",
    "secure",
    "httponly",
    "samesite"
  ]);

  return String(cookieString || "")
    .split(";")
    .map(part => part.trim())
    .filter(Boolean)
    .map(part => {
      const eqIndex = part.indexOf("=");

      if (eqIndex === -1) return null;

      const name = part.slice(0, eqIndex).trim();
      const value = part.slice(eqIndex + 1).trim();

      if (!name || ignoredNames.has(name.toLowerCase())) {
        return null;
      }

      return {
        name,
        value
      };
    })
    .filter(Boolean);
}

function cookieStringToPlaywrightCookies(cookieString) {
  const pairs = parseCookieString(cookieString);

  return pairs.map(cookie => ({
    name: cookie.name,
    value: cookie.value,
    domain: ".instagram.com",
    path: "/",
    secure: true
  }));
}

module.exports = {
  normalizeIgCookie,
  getIgCookieFromReq,
  parseCookieString,
  cookieStringToPlaywrightCookies
};