import dotenv from "dotenv";
dotenv.config();

import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import http from "http";
import { Server } from "socket.io";
import { initDb } from "./db";
import { initSocket } from "./socket";

import authRoutes from "./routes/auth";
import userRoutes from "./routes/users";
import friendRoutes from "./routes/friends";
import messageRoutes from "./routes/messages";
import callRoutes from "./routes/calls";
import notificationRoutes from "./routes/notifications";
import profileRoutes from "./routes/profile";
import privacyRoutes from "./routes/privacy";
import keyRoutes from "./routes/keys";
import mediaRoutes from "./routes/media";
import deviceRoutes from "./routes/devices";

initDb();

const app = express();
const server = http.createServer(app);

const allowedOrigins = (process.env.CLIENT_ORIGINS || process.env.CLIENT_ORIGIN || "http://localhost:3000")
  .split(",").map((value) => value.trim()).filter(Boolean);
const originAllowed = (origin?: string) => !origin || allowedOrigins.includes(origin);

const io = new Server(server, {
  cors: {
    origin: (origin, callback) => callback(null, originAllowed(origin)),
    methods: ["GET", "POST"],
    credentials: true,
  },
});

app.set("trust proxy", process.env.TRUST_PROXY === "1" ? 1 : false);
app.use(cors({ origin: (origin, callback) => callback(null, originAllowed(origin)), credentials: true, methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"] }));
app.disable("x-powered-by");
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "camera=(self), microphone=(self)");
  res.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive");
  res.setHeader("Cross-Origin-Resource-Policy", "same-site");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  next();
});
app.use(express.json({ limit: "1mb" }));

app.get("/api/health", (_req: Request, res: Response) => {
  res.json({ status: "ok", time: new Date().toISOString() });
});

app.use("/api/auth", authRoutes);
app.use("/api/users", userRoutes);
app.use("/api/friends", friendRoutes);
app.use("/api/messages", messageRoutes);
app.use("/api/calls", callRoutes);
app.use("/api/notifications", notificationRoutes);
app.use("/api/profile", profileRoutes);
app.use("/api/privacy", privacyRoutes);
app.use("/api/keys", keyRoutes);
app.use("/api/media", express.raw({ type: "application/octet-stream", limit: "50mb" }), mediaRoutes);
app.use("/api/devices", deviceRoutes);

app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  console.error("Unhandled server error", err instanceof Error ? err.message : err);
  if (!res.headersSent) res.status(500).json({ error: "Internal server error" });
});

app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: "Route not found" });
});

initSocket(io);

const PORT = Number(process.env.PORT) || 4000;
server.listen(PORT, () => {
  console.log(`Sakhya server running on http://localhost:${PORT}`);
  console.log(`Allowed client origins: ${allowedOrigins.join(", ")}`);
});

const shutdown = (signal: string) => {
  console.log(`${signal}: shutting down Sakhya server...`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
};
process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
