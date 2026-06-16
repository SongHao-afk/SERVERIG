const express = require("express");

const { PRIVATE_COOKIE_HEADER } = require("../config");
const { normalizeIgCookie } = require("../utils/cookie");
const { streamMediaUrlToResponse } = require("../services/download.service");

const router = express.Router();

router.get("/download", async (req, res) => {
  try {
    const mediaUrl = req.query.url;
    const igCookie = normalizeIgCookie(req.headers[PRIVATE_COOKIE_HEADER] || "");

    await streamMediaUrlToResponse(res, mediaUrl, igCookie);
  } catch (err) {
    res.status(500).send(err.message);
  }
});

module.exports = router;