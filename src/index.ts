import "dotenv/config";
import app from "./app";
import logger from "./lib/logger";
import { redis } from "./lib/redis";
import { prisma } from "./lib/prisma";
import "./jobs/premiumJobs";
import "./jobs/starsJobs";
import "./listeners/starsListeners";
const PORT = parseInt(process.env.PORT || "3000");

async function startServer() {
  try {
    // ── Test database connection
    await prisma.$connect();
    logger.info("✅ PostgreSQL connected");

    // ── Test Redis connection
    await redis.ping();
    logger.info("✅ Redis connected");

    // ── Start HTTP server
    app.listen(PORT, () => {
      logger.info(`
╔════════════════════════════════════════╗
║   Telegram Premium Backend             ║
║   Running on http://localhost:${PORT}     ║
║   Environment: ${process.env.NODE_ENV?.padEnd(20)}║
╚════════════════════════════════════════╝
      `);
    });

  } catch (error) {
    logger.error("❌ Failed to start server:", error);
    process.exit(1);
  }
}

// ── Graceful shutdown
process.on("SIGINT", async () => {
  logger.info("\n🔴 Shutting down gracefully...");
  await prisma.$disconnect();
  redis.disconnect();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await prisma.$disconnect();
  redis.disconnect();
  process.exit(0);
});

startServer();
