const nodemailer = require("nodemailer");

const {
  HEADLESS,
  SESSION_CHECK_INTERVAL_MS,
  SESSION_CHECK_MAX_ATTEMPTS,
  SESSION_CHECK_RETRY_DELAY_MS,
  ALERT_COOLDOWN_MS
} = require("../config");
const { sleep } = require("../utils/sleep");
const { getInstagramContext } = require("./context");
const { ensureInstagramLoggedIn } = require("./page");
const {
  getSessionStatus,
  setSessionStatus,
  isSessionCheckRunning,
  setSessionCheckRunning,
  getLastAlertSentAt,
  setLastAlertSentAt
} = require("./state");

async function sendSessionAlertEmail(errorMessage) {
  const now = Date.now();

  if (now - getLastAlertSentAt() < ALERT_COOLDOWN_MS) {
    console.log("⚠️ Đã gửi alert gần đây, bỏ qua để tránh spam email");
    return;
  }

  const {
    SMTP_HOST,
    SMTP_PORT,
    SMTP_SECURE,
    SMTP_USER,
    SMTP_PASS,
    ALERT_EMAIL_TO
  } = process.env;

  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS || !ALERT_EMAIL_TO) {
    console.log("⚠️ Thiếu SMTP config trong .env, không gửi được email alert");
    return;
  }

  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT || 587),
    secure: String(SMTP_SECURE || "false") === "true",
    auth: {
      user: SMTP_USER,
      pass: SMTP_PASS
    }
  });

  await transporter.sendMail({
    from: `"Instagram Downloader Server" <${SMTP_USER}>`,
    to: ALERT_EMAIL_TO,
    subject: "⚠️ Instagram default session lỗi hoặc hết hạn",
    text: [
      "Instagram default session checker đã thử tối đa 3 lần nhưng vẫn thất bại.",
      "",
      `Thời gian: ${new Date().toISOString()}`,
      `Lỗi: ${errorMessage}`,
      "",
      "Cần mở /setup-login để đăng nhập Instagram clone/default lại."
    ].join("\n")
  });

  setLastAlertSentAt(now);
  console.log("📧 Đã gửi email cảnh báo default session Instagram lỗi");
}

async function checkInstagramSessionWithRetry(reason = "manual", alertOnFail = false) {
  if (isSessionCheckRunning()) {
    console.log("⏳ Default session check đang chạy, bỏ qua lần gọi mới");
    return getSessionStatus().ok;
  }

  setSessionCheckRunning(true);

  try {
    let lastError = null;

    for (let attempt = 1; attempt <= SESSION_CHECK_MAX_ATTEMPTS; attempt++) {
      let page = null;

      try {
        console.log(
          `🔍 Check default Instagram session lần ${attempt}/${SESSION_CHECK_MAX_ATTEMPTS} | reason=${reason}`
        );

        const context = await getInstagramContext();
        page = await context.newPage();

        await ensureInstagramLoggedIn(page);

        setSessionStatus({
          ok: true,
          lastCheckedAt: new Date().toISOString(),
          lastError: null
        });

        console.log("✅ Default Instagram session OK");
        return true;
      } catch (err) {
        lastError = err;

        console.log(
          `❌ Check default Instagram session fail lần ${attempt}/${SESSION_CHECK_MAX_ATTEMPTS}:`,
          err.message
        );

        if (attempt < SESSION_CHECK_MAX_ATTEMPTS) {
          await sleep(SESSION_CHECK_RETRY_DELAY_MS);
        }
      } finally {
        if (page) {
          await page.close().catch(() => {});
        }
      }
    }

    setSessionStatus({
      ok: false,
      lastCheckedAt: new Date().toISOString(),
      lastError: lastError?.message || "Unknown error"
    });

    if (alertOnFail) {
      try {
        await sendSessionAlertEmail(getSessionStatus().lastError);
      } catch (emailErr) {
        console.log("❌ Không gửi được email alert:", emailErr.message);
      }
    }

    return false;
  } finally {
    setSessionCheckRunning(false);
  }
}

async function startInstagramSessionWatcher() {
  checkInstagramSessionWithRetry("server-start", true).catch(err => {
    console.log("❌ Startup default session check crashed:", err.message);
  });

  setInterval(() => {
    checkInstagramSessionWithRetry("scheduled-6h", true).catch(err => {
      console.log("❌ Scheduled default session check crashed:", err.message);
    });
  }, SESSION_CHECK_INTERVAL_MS);
}

function getSetupLoginHeadlessMessage() {
  if (!HEADLESS) return null;

  return "HEADLESS đang true. Đổi const HEADLESS = false rồi chạy lại server để login default/clone thủ công.";
}

module.exports = {
  sendSessionAlertEmail,
  checkInstagramSessionWithRetry,
  startInstagramSessionWatcher,
  getSetupLoginHeadlessMessage
};