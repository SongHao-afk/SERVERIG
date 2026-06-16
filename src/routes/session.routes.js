const express = require("express");

const { HEADLESS } = require("../config");
const { getInstagramContext } = require("../instagram/context");
const { getSessionStatus } = require("../instagram/state");
const { checkInstagramSessionWithRetry } = require("../instagram/session");

const router = express.Router();

router.get("/setup-login", async (req, res) => {
  try {
    if (HEADLESS) {
      return res
        .status(400)
        .send(
          "HEADLESS đang true. Đổi const HEADLESS = false rồi chạy lại server để login default/clone thủ công."
        );
    }

    const context = await getInstagramContext();
    const page = await context.newPage();

    await page.goto("https://www.instagram.com/accounts/login/", {
      waitUntil: "domcontentloaded",
      timeout: 60000
    });

    res.send(`
      <h2>Chrome Playwright đã mở.</h2>
      <p>Đây chỉ là login cho <b>default/clone session</b> của server.</p>
      <p>Private user login phải làm ở client WebView, không login trên server.</p>
      <p>Sau khi vào được Home/feed Instagram là default session đã lưu trong <b>./ig-session</b>.</p>
    `);
  } catch (err) {
    res.status(500).send(err.message);
  }
});

router.get("/session-status", (req, res) => {
  res.json({
    success: true,
    instagramSession: getSessionStatus()
  });
});

router.get("/check-session", async (req, res) => {
  const ok = await checkInstagramSessionWithRetry("manual-api", false);

  res.status(ok ? 200 : 500).json({
    success: ok,
    instagramSession: getSessionStatus()
  });
});

module.exports = router;