import cron from "node-cron";
import { prisma } from "../lib/prisma";
import { starsReconciliationService } from "../services/stars/StarsReconciliationService";
import { EventBus } from "../lib/eventBus";
import logger from "../lib/logger";

// ─────────────────────────────────────────
// JOB 1: Auto-unlock expired star locks
// Runs every 5 minutes
// ─────────────────────────────────────────
cron.schedule("*/5 * * * *", async () => {
  const expiredLocks = await prisma.starsLock.findMany({
    where: {
      isReleased: false,
      expiresAt: { lte: new Date() },
    },
    take: 50,
  });

  for (const lock of expiredLocks) {
    try {
      await prisma.$transaction(async (tx) => {
        await tx.starsWallet.update({
          where: { id: lock.walletId },
          data: {
            balance: { increment: lock.amount },
            lockedBalance: { decrement: lock.amount },
          },
        });

        await tx.starsLock.update({
          where: { id: lock.id },
          data: { isReleased: true, releasedAt: new Date() },
        });
      });

      await EventBus.emit("stars.lock_expired", {
        lockId: lock.id,
        userId: lock.userId,
        amount: lock.amount.toString(),
        reason: lock.reason,
      });

      logger.info(`✅ Released expired lock ${lock.id} for user ${lock.userId}`);
    } catch (err) {
      logger.error(`❌ Failed to release lock ${lock.id}:`, err);
    }
  }
});

// ─────────────────────────────────────────
// JOB 2: Daily Reconciliation
// Runs every day at 2am UTC
// ─────────────────────────────────────────
cron.schedule("0 2 * * *", async () => {
  logger.info("🔍 Running daily Stars reconciliation...");
  try {
    const report = await starsReconciliationService.runDailyReconciliation();

    if (!report.ledgerBalanced || report.discrepanciesFound > 0) {
      await EventBus.emit("stars.reconciliation_failed", report);
      logger.error("🚨 RECONCILIATION ISSUES FOUND:", report);
    } else {
      logger.info("✅ Reconciliation passed — all balances correct");
    }
  } catch (err) {
    logger.error("❌ Reconciliation job failed:", err);
  }
});

// ─────────────────────────────────────────
// JOB 3: Fail stuck pending orders
// Runs every 30 minutes
// Pending orders older than 2 hours = failed
// ─────────────────────────────────────────
cron.schedule("*/30 * * * *", async () => {
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);

  const stuckOrders = await prisma.starsPurchaseOrder.findMany({
    where: {
      status: "PENDING",
      createdAt: { lte: twoHoursAgo },
    },
    take: 100,
  });

  if (stuckOrders.length > 0) {
    await prisma.starsPurchaseOrder.updateMany({
      where: { id: { in: stuckOrders.map((o) => o.id) } },
      data: {
        status: "FAILED",
        failureReason: "Payment not completed within 2 hours",
      },
    });

    logger.info(`⚠️ Marked ${stuckOrders.length} stuck orders as failed`);
  }
});

logger.info("✅ Stars background jobs initialized");
