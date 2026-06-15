import { Hono } from "hono";
import { cors } from "hono/cors";
import { serveStatic } from "@hono/node-server/serve-static";
import path from "node:path";
import fs from "node:fs";
import { openaiRoutes } from "./routes/openai.js";
import { anthropicRoutes } from "./routes/anthropic.js";
import { apiRoutes } from "./routes/api.js";
import { userApiRoutes } from "./routes/user-api.js";
import { registerExtractor } from "./tags/registry.js";
import { agentDetector } from "./tags/extractors/agent-detector.js";
import { headerTags } from "./tags/extractors/header-tags.js";

function findDashboardRoot(): string | null {
  const candidates = [
    path.resolve(import.meta.dirname, "../dashboard"),
    path.resolve(import.meta.dirname, "../../dashboard/dist"),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, "index.html"))) return dir;
  }
  return null;
}

export function createServer() {
  registerExtractor(agentDetector);
  registerExtractor(headerTags);

  const app = new Hono();

  app.use("/*", cors());

  app.get("/health", (c) => c.json({ status: "ok", service: "tokenparty" }));

  app.route("/v1", openaiRoutes);
  app.route("/anthropic", anthropicRoutes);
  app.route("/api/user", userApiRoutes);
  app.route("/api", apiRoutes);

  const dashboardRoot = findDashboardRoot();
  if (dashboardRoot) {
    app.use("/assets/*", serveStatic({ root: dashboardRoot }));
    app.get("*", (c) => {
      const filePath = path.join(dashboardRoot, "index.html");
      const html = fs.readFileSync(filePath, "utf-8");
      return c.html(html);
    });
  }

  return app;
}
