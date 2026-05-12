import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { globalErrorHandler } from "./lib/errors";
import premiumRoutes from "./routes/premium.routes";
import starsRoutes from "./routes/stars.routes";
import giftsRoutes from "./routes/gifts.routes";
import reactionsRoutes from "./routes/reactions.routes";

const app = express();

// ─────────────────────────────────────────
// Security Middleware
// ─────────────────────────────────────────
app.use(helmet());
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS?.split(",") || ["http://localhost:3000"],
  credentials: true,
}));

// ─────────────────────────────────────────
// Body Parsing
// ─────────────────────────────────────────
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

// ─────────────────────────────────────────
// Global Rate Limiting
// ─────────────────────────────────────────
app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100,
    message: { error: "Too many requests, please try again later" },
    standardHeaders: true,
    legacyHeaders: false,
  })
);

// ─────────────────────────────────────────
// Health Check
// ─────────────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV,
    version: process.env.npm_package_version,
  });
});

// ─────────────────────────────────────────
// API Routes
// ─────────────────────────────────────────
const API_PREFIX = `/api/${process.env.API_VERSION || "v1"}`;

app.use(`${API_PREFIX}/premium`, premiumRoutes);
app.use(`${API_PREFIX}/stars`, starsRoutes);
app.use(`${API_PREFIX}/gifts`, giftsRoutes);
app.use(`${API_PREFIX}/reactions`, reactionsRoutes);
// More routes will be added each day

// ─────────────────────────────────────────
// 404 Handler
// ─────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({
    success: false,
    error: { code: "NOT_FOUND", message: "Route not found" },
  });
});

// ─────────────────────────────────────────
// Global Error Handler (must be last)
// ─────────────────────────────────────────
app.use(globalErrorHandler);

export default app;
