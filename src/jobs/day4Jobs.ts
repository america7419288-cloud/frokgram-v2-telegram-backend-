import cron from "node-cron";
import { withdrawalService } from "../services/creator/WithdrawalService";
import { creatorProfileService } from "../services/creator/CreatorProfileService";
import { EventBus } from "../lib/eventBus";
import { prisma } from "../lib/prisma";

// ─────────────────────────────────────────
// JOB 1: Process approved payouts
// Runs every 4 hours
// ─────────────────────────────────────────
cron.schedule("0 */4 * * *", async () => {
  console.log("💸 Processing approved payouts...");
  try {
    const result = await withdrawalService.processApprovedPayouts();
    console.log(
      `✅ Payouts: ${result.processed} completed, ${result.failed} failed`
    );
  } catch (err) {
    console.error("❌ Payout processing job failed:", err);
  }
});

// ─────────────────────────────────────────
// JOB 2: Compute daily creator analytics
// Runs every day at midnight
// ─────────────────────────────────────────
cron.schedule("0 0 * * *", async () => {
  console.log("📊 Computing daily creator analytics...");

  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const period = yesterday.toISOString().split("T")[0];

  const creators = await prisma.creatorProfile.findMany({
    where: { isMonetizationEnabled: true },
    select: { id: true, userId: true },
    take: 1000,
  });

  for (const creator of creators) {
    try {
      const dayStart = new Date(period);
      const dayEnd = new Date(period);
      dayEnd.setHours(23, 59, 59, 999);

      const [earnings, subs] = await Promise.all([
        prisma.creatorEarning.groupBy({
          by: ["sourceType"],
          where: {
            creatorId: creator.id,
            createdAt: { gte: dayStart, lte: dayEnd },
          },
          _sum: { netAmount: true },
        }),
        prisma.creatorEarning.count({
          where: {
            creatorId: creator.id,
            sourceType: "CHANNEL_SUBSCRIPTION",
            createdAt: { gte: dayStart, lte: dayEnd },
          },
        }),
      ]);

      const earningMap: Record<string, bigint> = {};
      let totalEarned = BigInt(0);
      for (const e of earnings) {
        earningMap[e.sourceType] = e._sum.netAmount ?? BigInt(0);
        totalEarned += earningMap[e.sourceType];
      }

      await prisma.creatorAnalyticsSnapshot.upsert({
        where: {
          creatorId_period_periodType: {
            creatorId: creator.id,
            period,
            periodType: "daily",
          },
        },
        update: {
          totalEarned,
          reactionEarned: earningMap["PAID_REACTION"] ?? BigInt(0),
          tipEarned: earningMap["MESSAGE_TIP"] ?? BigInt(0),
          subEarned: earningMap["CHANNEL_SUBSCRIPTION"] ?? BigInt(0),
          storyEarned: earningMap["PAID_STORY"] ?? BigInt(0),
          nftEarned: earningMap["NFT_SALE"] ?? BigInt(0),
          adEarned: earningMap["AD_REVENUE"] ?? BigInt(0),
          newSubscribers: subs,
        },
        create: {
          creatorId: creator.id,
          period,
          periodType: "daily",
          totalEarned,
          reactionEarned: earningMap["PAID_REACTION"] ?? BigInt(0),
          tipEarned: earningMap["MESSAGE_TIP"] ?? BigInt(0),
          subEarned: earningMap["CHANNEL_SUBSCRIPTION"] ?? BigInt(0),
          storyEarned: earningMap["PAID_STORY"] ?? BigInt(0),
          nftEarned: earningMap["NFT_SALE"] ?? BigInt(0),
          adEarned: earningMap["AD_REVENUE"] ?? BigInt(0),
          newSubscribers: subs,
        },
      });
    } catch (err) {
      console.error(
        `❌ Analytics computation failed for creator ${creator.id}:`,
        err
      );
    }
  }

  console.log(`✅ Analytics computed for ${creators.length} creators`);
});

// ─────────────────────────────────────────
// JOB 3: Auto-approve small payouts
// Runs every 2 hours
// Payouts under 5000 stars auto-approved
// ─────────────────────────────────────────
cron.schedule("0 */2 * * *", async () => {
  const AUTO_APPROVE_THRESHOLD = BigInt(5000);

  const smallPendingPayouts = await prisma.creatorPayout.findMany({
    where: {
      status: "PENDING",
      starsAmount: { lte: AUTO_APPROVE_THRESHOLD },
      requestedAt: {
        lte: new Date(Date.now() - 60 * 60 * 1000), // at least 1 hour old
      },
    },
    take: 100,
  });

  if (smallPendingPayouts.length > 0) {
    await prisma.creatorPayout.updateMany({
      where: {
        id: { in: smallPendingPayouts.map((p) => p.id) },
      },
      data: { status: "APPROVED" },
    });

    console.log(
      `✅ Auto-approved ${smallPendingPayouts.length} small payouts`
    );
  }
});

// ─────────────────────────────────────────
// JOB 4: Update subscriber counts
// Runs every 30 minutes
// ─────────────────────────────────────────
cron.schedule("*/30 * * * *", async () => {
  const creators = await prisma.creatorProfile.findMany({
    where: { isMonetizationEnabled: true },
    select: { id: true, userId: true },
    take: 500,
  });

  for (const creator of creators) {
    const subCount = await prisma.creatorEarning.groupBy({
      by: ["sourceId"],
      where: {
        creatorId: creator.id,
        sourceType: "CHANNEL_SUBSCRIPTION",
      },
    });

    await prisma.creatorProfile.update({
      where: { id: creator.id },
      data: { subscriberCount: subCount.length },
    });
  }
});

console.log("✅ Day 4 background jobs initialized");
