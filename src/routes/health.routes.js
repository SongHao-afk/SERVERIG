const express = require("express");

const router = express.Router();

router.get("/", (req, res) => {
  res.json({
    success: true,
    message: "Instagram Downloader API chạy ngon 😎",
    mode: "client-cookie-private-mode",
    publicMode: {
      description: "Không gửi cookie, server dùng default session trong ./ig-session",
      setupLogin: "http://localhost:3000/setup-login",
      sessionStatus: "http://localhost:3000/session-status",
      checkSession: "http://localhost:3000/check-session"
    },
    privateMode: {
      description:
        "Client tự login Instagram bằng WebView, lấy cookie rồi gửi cookie lên server cho từng request. Server không lưu private session.",
      resolve: {
        method: "POST",
        url: "http://localhost:3000/resolve",
        body: {
          url: "instagram_url_here",
          igCookie: "sessionid=...; ds_user_id=...; csrftoken=..."
        },
        headerAlternative: {
          "x-ig-cookie": "sessionid=...; ds_user_id=...; csrftoken=..."
        }
      },
      profile: {
        storyGroups: {
          method: "POST",
          url: "http://localhost:3000/profile/story-groups",
          body: {
            profileUrl: "https://www.instagram.com/username/"
          }
        },
        storyGroupItems: {
          method: "POST",
          url: "http://localhost:3000/profile/story-group-items",
          body: {
            groupId: "active:username hoặc highlight:id",
            username: "username"
          }
        },
        downloadStoryItem: {
          method: "POST",
          url: "http://localhost:3000/profile/download-story-item",
          body: {
            downloadKey: "downloadKey_from_story_group_items"
          }
        }
      },
      download: {
        method: "GET",
        url: "http://localhost:3000/download?url=media_url",
        requiredHeaderWhenPrivate: {
          "x-ig-cookie": "sessionid=...; ds_user_id=...; csrftoken=..."
        }
      }
    }
  });
});

module.exports = router;