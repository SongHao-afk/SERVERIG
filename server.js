require("dotenv").config();

const express = require("express");
const cors = require("cors");

const healthRoutes = require("./src/routes/health.routes");
const sessionRoutes = require("./src/routes/session.routes");
const resolveRoutes = require("./src/routes/resolve.routes");
const downloadRoutes = require("./src/routes/download.routes");
const profileRoutes = require("./src/routes/profile.routes");

const { HEADLESS } = require("./src/config");
const { startInstagramSessionWatcher } = require("./src/instagram/session");
const { closeDefaultInstagramContext } = require("./src/instagram/context");

const app = express();

app.use(cors());
app.use(express.json({ limit: "1mb" }));

app.use("/", healthRoutes);
app.use("/", sessionRoutes);
app.use("/", resolveRoutes);
app.use("/", downloadRoutes);
app.use("/profile", profileRoutes);

app.listen(3000, () => {
  console.log("🚀 Server chạy tại http://localhost:3000");

  if (HEADLESS) {
    console.log("🤖 HEADLESS=true → bật watcher check default Instagram session.");
    startInstagramSessionWatcher();
  } else {
    console.log(
      "🧑‍💻 HEADLESS=false → bỏ qua watcher để login Instagram thủ công qua /setup-login."
    );
  }
});

async function shutdown() {
  await closeDefaultInstagramContext();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);