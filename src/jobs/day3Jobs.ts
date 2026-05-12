import cron from "node-cron";
import { GiftStatus } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { revenueSettlementService } from "../services/stars/RevenueSettlementService";
import { starsWalletService } from "../services/stars/StarsWalletService";
import { EventBus } from "../lib/eventBus";
import logger from "../lib/logger";

// ─────────────────────────────────────────
// JOB 1: Settle creator revenue
// Runs every hour at :00
// ─────────────────────────────────────────
cron.schedule("0 * * * *", async () => {
  logger.info("💰 Processing revenue settlements...");
  try {
    const result = await revenueSettlementService.processPendingSettlements();
    logger.info(
      `✅ Settled ${result.totalStarsSettled} stars to ${result.processed} creators`
    );
  } catch (err) {
    logger.error("❌ Settlement job failed:", err);
  }
});

// ─────────────────────────────────────────
// JOB 2: Expire unclaimed gifts
// Runs every hour at :30
// ─────────────────────────────────────────
cron.schedule("30 * * * *", async () => {
  logger.info("🎁 Checking for expired gifts...");

  const expiredGifts = await prisma.starsGift.findMany({
    where: {
      status: GiftStatus.PENDING,
      expiresAt: { lte: new Date() },
    },
    take: 100,
  });

  for (const gift of expiredGifts) {
    try {
      // Find and release the lock (returns stars to sender)
      const lock = await prisma.starsLock.findFirst({
        where: {
          referenceId: gift.id,
          isReleased: false,
          userId: gift.fromUserId,
        },
      });

      if (lock) {
        await starsWalletService.unlockStars(lock.id);
      }

      // Mark gift as expired
      await prisma.starsGift.update({
        where: { id: gift.id },
        data: { status: GiftStatus.EXPIRED },
      });

      await EventBus.emit("gift.expired", {
        giftId: gift.id,
        fromUserId: gift.fromUserId,
        toUserId: gift.toUserId,
        starsRefunded: gift.starsAmount.toString(),
      });

      logger.info(`✅ Expired gift ${gift.id}, stars returned to ${gift.fromUserId}`);
    } catch (err) {
      logger.error(`❌ Failed to expire gift ${gift.id}:`, err);
    }
  }

  if (expiredGifts.length > 0) {
    logger.info(`✅ Processed ${expiredGifts.length} expired gifts`);
  }
});

// ─────────────────────────────────────────
// JOB 3: Retry failed settlements
// Runs every 6 hours
// ─────────────────────────────────────────
cron.schedule("0 */6 * * *", async () => {
  const failedCount = await prisma.revenueSettlement.updateMany({
    where: { status: "FAILED" },
    data: { status: "PENDING" },
  });

  if (failedCount.count > 0) {
    logger.info(`🔄 Reset ${failedCount.count} failed settlements for retry`);
  }
});

logger.info("✅ Stars social background jobs initialized");
