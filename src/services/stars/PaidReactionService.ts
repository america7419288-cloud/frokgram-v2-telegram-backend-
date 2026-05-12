import {
  StarsTransactionType,
} from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { starsWalletService } from "./StarsWalletService";
import { revenueSettlementService } from "./RevenueSettlementService";
import { AppError } from "../../lib/errors";
import { EventBus } from "../../lib/eventBus";
import { redis } from "../../lib/redis";

// ─────────────────────────────────────────
// Config
// ─────────────────────────────────────────
const REACTION_CONFIG = {
  MIN_STARS: BigInt(1),
  MAX_STARS: BigInt(2500),
  PLATFORM_FEE_PERCENT: 30,          // platform takes 30%
  OWNER_REVENUE_PERCENT: 70,         // channel owner gets 70%
  LEADERBOARD_CACHE_TTL: 300,        // 5 minutes
  MAX_REACTIONS_PER_MESSAGE: 1000,   // anti-spam
  COOLDOWN_SECONDS: 3,               // per user per message
};

// ─────────────────────────────────────────
// Cache Keys
// ─────────────────────────────────────────
const ReactionCacheKeys = {
  leaderboard: (entityId: string, type: string) =>
    `reactions:leaderboard:${type}:${entityId}`,
  messageTotal: (messageId: string) =>
    `reactions:total:message:${messageId}`,
  userCooldown: (userId: string, messageId: string) =>
    `reactions:cooldown:${userId}:${messageId}`,
};

// ─────────────────────────────────────────
// Paid Reaction Service
// ─────────────────────────────────────────
export class PaidReactionService {

  // ─────────────────────────────────────
  // SEND PAID REACTION
  // User sends stars with a reaction emoji
  // on a channel message
  // ─────────────────────────────────────
  async sendPaidReaction(
    userId: string,
    chatId: string,
    messageId: string,
    emoji: string,
    starsAmount: bigint,
    ownerUserId: string,
    options: { isAnonymous?: boolean } = {}
  ): Promise<{
    reactionId: string;
    starsSpent: bigint;
    ownerEarned: bigint;
    newLeaderboardPosition: number;
  }> {
    // ── Validations ─────────────────────
    if (starsAmount < REACTION_CONFIG.MIN_STARS) {
      throw new AppError(
        "BELOW_MINIMUM",
        `Minimum reaction is ${REACTION_CONFIG.MIN_STARS} star`,
        400
      );
    }
    if (starsAmount > REACTION_CONFIG.MAX_STARS) {
      throw new AppError(
        "ABOVE_MAXIMUM",
        `Maximum reaction is ${REACTION_CONFIG.MAX_STARS} stars`,
        400
      );
    }
    if (userId === ownerUserId) {
      throw new AppError(
        "SELF_REACTION",
        "Cannot send paid reaction on your own message",
        400
      );
    }

    // ── Rate limit / cooldown ────────────
    const cooldownKey = ReactionCacheKeys.userCooldown(userId, messageId);
    const onCooldown = await redis.get(cooldownKey);
    if (onCooldown) {
      throw new AppError(
        "REACTION_COOLDOWN",
        `Please wait ${REACTION_CONFIG.COOLDOWN_SECONDS} seconds between reactions on the same message`,
        429
      );
    }

    // ── Check message reaction count ─────
    const existingCount = await prisma.paidReaction.count({
      where: { messageId, chatId },
    });
    if (existingCount >= REACTION_CONFIG.MAX_REACTIONS_PER_MESSAGE) {
      throw new AppError(
        "REACTION_LIMIT_REACHED",
        "This message has reached its maximum paid reactions",
        409
      );
    }

    // ── Calculate splits ─────────────────
    const platformFee =
      (starsAmount * BigInt(REACTION_CONFIG.PLATFORM_FEE_PERCENT)) / BigInt(100);
    const ownerEarned = starsAmount - platformFee;

    // ── Execute atomically ───────────────
    const result = await prisma.$transaction(async (tx) => {
      // 1. Debit stars from reactor
      const debitResult = await starsWalletService.debitStars(
        userId,
        starsAmount,
        StarsTransactionType.REACTION,
        {
          toUserId: ownerUserId,
          referenceId: messageId,
          referenceType: "message_reaction",
          description: `Paid reaction ${emoji} on message`,
          metadata: {
            chatId,
            messageId,
            emoji,
            platformFee: platformFee.toString(),
            ownerEarned: ownerEarned.toString(),
          },
        }
      );

      // 2. Create reaction record
      const reaction = await tx.paidReaction.create({
        data: {
          messageId,
          chatId,
          userId,
          starsAmount,
          emoji,
          isAnonymous: options.isAnonymous ?? false,
          ownerUserId,
          platformFee,
          ownerEarned,
        },
      });

      // 3. Queue revenue settlement for owner
      await revenueSettlementService.queueSettlement(
        ownerUserId,
        "reaction",
        reaction.id,
        starsAmount,
        platformFee,
        ownerEarned
      );

      // 4. Update leaderboard
      await this.updateLeaderboard(
        tx,
        messageId,
        "message",
        userId,
        starsAmount
      );
      await this.updateLeaderboard(
        tx,
        chatId,
        "chat",
        userId,
        starsAmount
      );

      return { reaction, debitResult };
    });

    // ── Set cooldown ─────────────────────
    await redis.setex(
      cooldownKey,
      REACTION_CONFIG.COOLDOWN_SECONDS,
      "1"
    );

    // ── Invalidate caches ────────────────
    await Promise.all([
      redis.del(ReactionCacheKeys.leaderboard(messageId, "message")),
      redis.del(ReactionCacheKeys.leaderboard(chatId, "chat")),
      redis.del(ReactionCacheKeys.messageTotal(messageId)),
    ]);

    // ── Get new leaderboard position ─────
    const position = await this.getUserLeaderboardPosition(
      messageId,
      "message",
      userId
    );

    // ── Emit event ───────────────────────
    await EventBus.emit("reaction.paid", {
      reactionId: result.reaction.id,
      fromUserId: userId,
      ownerUserId,
      chatId,
      messageId,
      emoji,
      starsAmount: starsAmount.toString(),
      ownerEarned: ownerEarned.toString(),
    });

    return {
      reactionId: result.reaction.id,
      starsSpent: starsAmount,
      ownerEarned,
      newLeaderboardPosition: position,
    };
  }

  // ─────────────────────────────────────
  // GET REACTION LEADERBOARD
  // Top reactors for a message or chat
  // ─────────────────────────────────────
  async getLeaderboard(
    entityId: string,
    entityType: "message" | "chat",
    limit: number = 10
  ) {
    const cacheKey = ReactionCacheKeys.leaderboard(entityId, entityType);
    const cached = await redis.get(cacheKey);
    if (cached) return JSON.parse(cached);

    const leaderboard = await prisma.reactionLeaderboard.findMany({
      where: { entityId, entityType },
      orderBy: { totalStars: "desc" },
      take: Math.min(limit, 50),
    });

    const result = leaderboard.map((entry, index) => ({
      position: index + 1,
      userId: entry.userId,
      totalStars: entry.totalStars.toString(),
      reactionCount: entry.reactionCount,
      lastReactedAt: entry.lastReactedAt,
    }));

    await redis.setex(
      cacheKey,
      REACTION_CONFIG.LEADERBOARD_CACHE_TTL,
      JSON.stringify(result)
    );

    return result;
  }

  // ─────────────────────────────────────
  // GET MESSAGE TOTAL STARS
  // Total stars received by a message
  // ─────────────────────────────────────
  async getMessageTotalStars(messageId: string): Promise<{
    totalStars: bigint;
    uniqueReactors: number;
    topEmoji: string | null;
  }> {
    const cacheKey = ReactionCacheKeys.messageTotal(messageId);
    const cached = await redis.get(cacheKey);
    if (cached) {
      const parsed = JSON.parse(cached);
      return { ...parsed, totalStars: BigInt(parsed.totalStars) };
    }

    const [aggregate, emojiGroups] = await Promise.all([
      prisma.paidReaction.aggregate({
        where: { messageId },
        _sum: { starsAmount: true },
        _count: { userId: true },
      }),
      prisma.paidReaction.groupBy({
        by: ["emoji"],
        where: { messageId },
        _sum: { starsAmount: true },
        orderBy: { _sum: { starsAmount: "desc" } },
        take: 1,
      }),
    ]);

    const result = {
      totalStars: aggregate._sum.starsAmount ?? BigInt(0),
      uniqueReactors: aggregate._count.userId,
      topEmoji: emojiGroups[0]?.emoji ?? null,
    };

    await redis.setex(
      cacheKey,
      60, // 1 minute cache for totals
      JSON.stringify({
        ...result,
        totalStars: result.totalStars.toString(),
      })
    );

    return result;
  }

  // ─────────────────────────────────────
  // GET TOP REACTORS FOR CHAT (period)
  // ─────────────────────────────────────
  async getTopReactors(
    chatId: string,
    period: "day" | "week" | "month" | "all" = "week",
    limit: number = 10
  ) {
    const startDate = this.getPeriodStartDate(period);

    const where: any = { chatId };
    if (startDate) where.createdAt = { gte: startDate };

    const topReactors = await prisma.paidReaction.groupBy({
      by: ["userId", "isAnonymous"],
      where,
      _sum: { starsAmount: true },
      _count: { id: true },
      orderBy: { _sum: { starsAmount: "desc" } },
      take: Math.min(limit, 100),
    });

    return topReactors.map((r, index) => ({
      position: index + 1,
      userId: r.isAnonymous ? null : r.userId,
      isAnonymous: r.isAnonymous,
      totalStars: (r._sum.starsAmount ?? BigInt(0)).toString(),
      reactionCount: r._count.id,
    }));
  }

  // ─────────────────────────────────────
  // PRIVATE: Update leaderboard entry
  // ─────────────────────────────────────
  private async updateLeaderboard(
    tx: any,
    entityId: string,
    entityType: string,
    userId: string,
    starsAmount: bigint
  ): Promise<void> {
    await tx.reactionLeaderboard.upsert({
      where: {
        entityId_entityType_userId: {
          entityId,
          entityType,
          userId,
        },
      },
      update: {
        totalStars: { increment: starsAmount },
        reactionCount: { increment: 1 },
        lastReactedAt: new Date(),
      },
      create: {
        entityId,
        entityType,
        userId,
        totalStars: starsAmount,
        reactionCount: 1,
      },
    });
  }

  // ─────────────────────────────────────
  // PRIVATE: Get user position in leaderboard
  // ─────────────────────────────────────
  private async getUserLeaderboardPosition(
    entityId: string,
    entityType: string,
    userId: string
  ): Promise<number> {
    const userEntry = await prisma.reactionLeaderboard.findUnique({
      where: { entityId_entityType_userId: { entityId, entityType, userId } },
    });

    if (!userEntry) return 0;

    const rank = await prisma.reactionLeaderboard.count({
      where: {
        entityId,
        entityType,
        totalStars: { gt: userEntry.totalStars },
      },
    });

    return rank + 1;
  }

  // ─────────────────────────────────────
  // PRIVATE: Period start date
  // ─────────────────────────────────────
  private getPeriodStartDate(
    period: "day" | "week" | "month" | "all"
  ): Date | null {
    const now = new Date();
    switch (period) {
      case "day":
        return new Date(now.getTime() - 24 * 60 * 60 * 1000);
      case "week":
        return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      case "month":
        return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      case "all":
        return null;
    }
  }
}

export const paidReactionService = new PaidReactionService();
