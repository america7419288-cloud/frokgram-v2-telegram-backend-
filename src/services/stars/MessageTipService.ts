import {
  StarsTransactionType,
} from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { starsWalletService } from "./StarsWalletService";
import { revenueSettlementService } from "./RevenueSettlementService";
import { AppError } from "../../lib/errors";
import { EventBus } from "../../lib/eventBus";

// ─────────────────────────────────────────
// Config
// ─────────────────────────────────────────
const TIP_CONFIG = {
  MIN_STARS: BigInt(1),
  MAX_STARS: BigInt(10000),
  PLATFORM_FEE_PERCENT: 15,    // lower fee for tips vs reactions
  MAX_TIPS_PER_DAY: 100,
};

// ─────────────────────────────────────────
// Message Tip Service
// ─────────────────────────────────────────
export class MessageTipService {

  // ─────────────────────────────────────
  // TIP A MESSAGE
  // Tip the author of a specific message
  // ─────────────────────────────────────
  async tipMessage(
    fromUserId: string,
    toUserId: string,
    starsAmount: bigint,
    options: {
      messageId?: string;
      chatId?: string;
      tipMessage?: string;
      isAnonymous?: boolean;
    } = {}
  ): Promise<{
    tipId: string;
    starsSpent: bigint;
    creatorEarned: bigint;
    transactionId: string;
  }> {
    // ── Validations ─────────────────────
    if (fromUserId === toUserId) {
      throw new AppError("SELF_TIP", "Cannot tip yourself", 400);
    }
    if (starsAmount < TIP_CONFIG.MIN_STARS) {
      throw new AppError(
        "BELOW_MINIMUM",
        `Minimum tip is ${TIP_CONFIG.MIN_STARS} star`,
        400
      );
    }
    if (starsAmount > TIP_CONFIG.MAX_STARS) {
      throw new AppError(
        "ABOVE_MAXIMUM",
        `Maximum tip is ${TIP_CONFIG.MAX_STARS} stars`,
        400
      );
    }

    // ── Daily limit check ────────────────
    await this.checkDailyTipLimit(fromUserId);

    // ── Calculate splits ─────────────────
    const platformFee =
      (starsAmount * BigInt(TIP_CONFIG.PLATFORM_FEE_PERCENT)) / BigInt(100);
    const creatorEarned = starsAmount - platformFee;

    // ── Execute atomically ───────────────
    const result = await prisma.$transaction(async (tx) => {
      // 1. Debit sender
      const debitResult = await starsWalletService.debitStars(
        fromUserId,
        starsAmount,
        StarsTransactionType.TIP,
        {
          toUserId,
          referenceId: options.messageId,
          referenceType: options.messageId ? "message" : "creator",
          description: options.tipMessage
            ? `Tip: "${options.tipMessage}"`
            : "Stars tip",
          metadata: {
            messageId: options.messageId,
            chatId: options.chatId,
            isAnonymous: options.isAnonymous,
            platformFee: platformFee.toString(),
            creatorEarned: creatorEarned.toString(),
          },
        }
      );

      // 2. Create tip record
      const tip = await tx.messageTip.create({
        data: {
          fromUserId,
          toUserId,
          messageId: options.messageId ?? null,
          chatId: options.chatId ?? null,
          starsAmount,
          message: options.tipMessage ?? null,
          isAnonymous: options.isAnonymous ?? false,
          platformFee,
          creatorEarned,
        },
      });

      // 3. Queue revenue settlement
      await revenueSettlementService.queueSettlement(
        toUserId,
        "tip",
        tip.id,
        starsAmount,
        platformFee,
        creatorEarned
      );

      return { tip, debitResult };
    });

    // ── Emit event ───────────────────────
    await EventBus.emit("tip.sent", {
      tipId: result.tip.id,
      fromUserId: options.isAnonymous ? null : fromUserId,
      toUserId,
      starsAmount: starsAmount.toString(),
      creatorEarned: creatorEarned.toString(),
      messageId: options.messageId,
    });

    return {
      tipId: result.tip.id,
      starsSpent: starsAmount,
      creatorEarned,
      transactionId: result.debitResult.transactionId,
    };
  }

  // ─────────────────────────────────────
  // GET MESSAGE EARNINGS
  // How much a message has earned in tips
  // ─────────────────────────────────────
  async getMessageEarnings(messageId: string): Promise<{
    totalTips: bigint;
    totalStars: bigint;
    uniqueTippers: number;
    topTip: bigint;
  }> {
    const [aggregate, topTip] = await Promise.all([
      prisma.messageTip.aggregate({
        where: { messageId },
        _sum: { starsAmount: true },
        _count: { fromUserId: true },
      }),
      prisma.messageTip.findFirst({
        where: { messageId },
        orderBy: { starsAmount: "desc" },
        select: { starsAmount: true },
      }),
    ]);

    return {
      totalTips: BigInt(aggregate._count.fromUserId),
      totalStars: aggregate._sum.starsAmount ?? BigInt(0),
      uniqueTippers: aggregate._count.fromUserId,
      topTip: topTip?.starsAmount ?? BigInt(0),
    };
  }

  // ─────────────────────────────────────
  // GET CREATOR EARNINGS (from tips)
  // ─────────────────────────────────────
  async getCreatorTipEarnings(
    creatorId: string,
    period: "day" | "week" | "month" | "all" = "month"
  ) {
    const startDate = this.getPeriodStartDate(period);
    const where: any = { toUserId: creatorId };
    if (startDate) where.createdAt = { gte: startDate };

    const [aggregate, byMessage] = await Promise.all([
      prisma.messageTip.aggregate({
        where,
        _sum: { starsAmount: true, creatorEarned: true },
        _count: { id: true },
      }),
      prisma.messageTip.groupBy({
        by: ["messageId"],
        where: { ...where, messageId: { not: null } },
        _sum: { starsAmount: true },
        _count: { id: true },
        orderBy: { _sum: { starsAmount: "desc" } },
        take: 5,
      }),
    ]);

    return {
      totalReceived: aggregate._sum.starsAmount ?? BigInt(0),
      totalEarned: aggregate._sum.creatorEarned ?? BigInt(0),
      totalTips: aggregate._count.id,
      period,
      topMessages: byMessage.map((m) => ({
        messageId: m.messageId,
        totalStars: (m._sum.starsAmount ?? BigInt(0)).toString(),
        tipCount: m._count.id,
      })),
    };
  }

  // ─────────────────────────────────────
  // PRIVATE: Daily tip limit
  // ─────────────────────────────────────
  private async checkDailyTipLimit(userId: string): Promise<void> {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const count = await prisma.messageTip.count({
      where: {
        fromUserId: userId,
        createdAt: { gte: today },
      },
    });

    if (count >= TIP_CONFIG.MAX_TIPS_PER_DAY) {
      throw new AppError(
        "DAILY_TIP_LIMIT",
        `Daily tip limit of ${TIP_CONFIG.MAX_TIPS_PER_DAY} reached`,
        429
      );
    }
  }

  private getPeriodStartDate(
    period: "day" | "week" | "month" | "all"
  ): Date | null {
    const now = new Date();
    switch (period) {
      case "day": return new Date(now.getTime() - 24 * 60 * 60 * 1000);
      case "week": return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      case "month": return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      case "all": return null;
    }
  }
}

export const messageTipService = new MessageTipService();
