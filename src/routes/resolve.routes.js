const express = require("express");

const { getIgCookieFromReq } = require("../utils/cookie");
const { extractInstagramMedia } = require("../instagram/html-resolver");

const router = express.Router();

router.post("/resolve", async (req, res) => {
  try {
    const { url } = req.body;
    const igCookie = getIgCookieFromReq(req);

    if (!url) {
      return res.status(400).json({
        success: false,
        error: "Thiếu url"
      });
    }

    const data = await extractInstagramMedia(url, {
      igCookie
    });

    res.json(data);
  } catch (err) {
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

module.exports = router;