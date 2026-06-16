const IG_SESSION_DIR = "./ig-session";
const HEADLESS = true;

const DESKTOP_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

const MOBILE_UA =
  "Mozilla/5.0 (Linux; Android 10; Pixel 5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36";

const PRIVATE_COOKIE_HEADER = "x-ig-cookie";

// =========================
// PLAYWRIGHT / CHROMIUM
// =========================

// Mục tiêu:
// - Dùng session folder mới sạch
// - Tắt popup "Sign in as..."
// - Tắt popup "Sign in easily"
// - Tắt password manager/autofill
// - Giảm mấy dấu hiệu automation lộ liễu
const CHROMIUM_ARGS = [
  "--disable-blink-features=AutomationControlled",

  "--no-first-run",
  "--no-default-browser-check",
  "--disable-popup-blocking",
  "--disable-notifications",

  "--disable-sync",
  "--disable-save-password-bubble",

  "--disable-features=PasswordManagerOnboarding,AutofillServerCommunication,AutofillEnableAccountWalletStorage,AutofillEnablePaymentsMandatoryReauth",

  "--password-store=basic",
  "--use-mock-keychain",
];

// =========================
// DEFAULT SESSION CHECK
// =========================

// Khi HEADLESS=false thì server.js đã bỏ watcher,
// nên mấy biến này chỉ dùng khi HEADLESS=true.
const SESSION_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const SESSION_CHECK_MAX_ATTEMPTS = 3;
const SESSION_CHECK_RETRY_DELAY_MS = 10 * 1000;
const ALERT_COOLDOWN_MS = 6 * 60 * 60 * 1000;

module.exports = {
  IG_SESSION_DIR,
  HEADLESS,

  DESKTOP_UA,
  MOBILE_UA,
  PRIVATE_COOKIE_HEADER,

  CHROMIUM_ARGS,

  SESSION_CHECK_INTERVAL_MS,
  SESSION_CHECK_MAX_ATTEMPTS,
  SESSION_CHECK_RETRY_DELAY_MS,
  ALERT_COOLDOWN_MS,
};