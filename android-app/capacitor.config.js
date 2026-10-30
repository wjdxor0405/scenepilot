// Read by the Capacitor CLI on `cap sync`. Mixed content (an https app page calling an http:// server) is allowed only
// when the last `node build-www.mjs` built the app for an http:// server; a build for an https:// server does not need it.
const { existsSync, readFileSync } = require("node:fs");
const { join } = require("node:path");

const buildInfo = join(__dirname, "www", "build.json");
const apiBase = existsSync(buildInfo) ? JSON.parse(readFileSync(buildInfo, "utf-8")).apiBase : "";

module.exports = {
  appId: "com.scenepilot.app",
  appName: "ScenePilot",
  webDir: "www",
  server: { androidScheme: "https" },
  android: { allowMixedContent: !apiBase.startsWith("https://") },
};
