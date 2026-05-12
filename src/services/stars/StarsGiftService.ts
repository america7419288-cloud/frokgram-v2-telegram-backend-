import {
  GiftStatus,
  StarsTransactionType,
} from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { starsWalletService } from "./StarsWalletService";
import { AppError } from "../../lib/errors";
import { EventBus } from "../../lib/eventBus";
import { redis } from "../../lib/redis";

// ─────────────────────────────────────────
// Types
// ─────────────────────────────────────────
export interface SendGiftOptions {
  fromUserId: string;
  toUserId: string;
  starsAmount: bigint;
  animationId?: string;
  message?: string;
}

export interface GiftDetails {
  id: string;
  fromUserId: string;
  toUserId: string;
  starsAmount: bigint;
  message: string | null;
  status: GiftStatus;
  animation: {
    name: string;
    displayName: string;
    lottieUrl: string;
    rarity: string;
  } | null;
  claimedAt: Date | null;
  expiresAt: Date;
  createdAt: Date;
}

// ─────────────────────────────────────────
// Config
// ─────────────────────────────────────────
const GIFT_CONFIG = {
  EXPIRY_DAYS: 30,
  MIN_STARS: BigInt(50),
  MAX_STARS: BigInt(100000),
  MAX_DAILY_GIFTS_SENT: 50,
  MAX_DAILY_GIFTS_RECEIVED: 100,
  REJECTION_REFUND_WINDOW_HOURS: 24, // sender gets refund if rejected within 24h
};

// ─────────────────────────────────────────
// Cache Keys
// ─────────────────────────────────────────
const GiftCacheKeys = {
  receivedGifts: (userId: string) => `gifts:received:${userId}`,
  sentGifts: (userId: string) => `gifts:sent:${userId}`,
  animations: () => `gifts:animations`,
  giftDetails: (giftId: string) => `gifts:details:${giftId}`,
};

// ─────────────────────────────────────────
// Stars Gift Service
// ─────────────────────────────────────────
export class StarsGiftService {

  // ─────────────────────────────────────
  // SEND GIFT
  // Stars are locked (not debited yet)
  // until recipient claims or rejects
  // ─────────────────────────────────────
  async sendGift(options: SendGiftOptions): Promise<{
    giftId: string;
    lockId: string;
    expiresAt: Date;
  }> {
    const { fromUserId, toUserId, starsAmount, animationId, message } = options;

    // ── Validations ─────────────────────
    if (fromUserId === toUserId) {
      throw new AppError("SELF_GIFT", "Cannot send a gift to yourself", 400);
    }

    if (starsAmount < GIFT_CONFIG.MIN_STARS) {
      throw new AppError(
        "BELOW_MINIMUM",
        `Minimum gift amount is ${GIFT_CONFIG.MIN_STARS} stars`,
        400,
        { minimum: GIFT_CONFIG.MIN_STARS.toString() }
      );
    }

    if (starsAmount > GIFT_CONFIG.MAX_STARS) {
      throw new AppError(
        "ABOVE_MAXIMUM",
        `Maximum gift amount is ${GIFT_CONFIG.MAX_STARS} stars`,
        400
      );
    }

    // ── Check daily limits ───────────────
    await this.checkDailyGiftLimits(fromUserId, toUserId);

    // ── Validate animation ───────────────
    if (animationId) {
      const animation = await prisma.giftAnimation.findFirst({
        where: { id: animationId, isAvailable: true },
      });
      if (!animation) {
        throw new AppError("ANIMATION_NOT_FOUND", "Gift animation not found", 404);
      }
      // Check if animation has minimum star requirement
      if (starsAmount < animation.priceStars) {
        throw new AppError(
          "INSUFFICIENT_FOR_ANIMATION",
          `This animation requires at least ${animation.priceStars} stars`,
          400,
          { required: animation.priceStars.toString() }
        );
      }
    }

    // ── Verify recipient exists ──────────
    const recipientWallet = await starsWalletService.getOrCreateWallet(toUserId);
    if (!recipientWallet) {
      throw new AppError("RECIPIENT_NOT_FOUND", "Recipient not found", 404);
    }

    const expiresAt = new Date(
      Date.now() + GIFT_CONFIG.EXPIRY_DAYS * 24 * 60 * 60 * 1000
    );

    // ── Lock stars from sender ───────────
    // Stars are locked until gift is claimed or rejected
    let lockId: string;
    let giftId: string;

    try {
      lockId = await starsWalletService.lockStars(
        fromUserId,
        starsAmount,
        "gift_pending",
        undefined, // will update with giftId after creation
        GIFT_CONFIG.EXPIRY_DAYS * 24 * 60 // expiry in minutes
      );
    } catch (err) {
      throw new AppError(
        "INSUFFICIENT_STARS",
        "Not enough stars to send this gift",
        402
      );
    }

    // ── Create gift record ───────────────
    const gift = await prisma.starsGift.create({
      data: {
        fromUserId,
        toUserId,
        starsAmount,
        animationId: animationId ?? null,
        message: message ?? null,
        status: GiftStatus.PENDING,
        expiresAt,
      },
    });

    giftId = gift.id;

    // Update lock with gift reference
    await prisma.starsLock.update({
      where: { id: lockId },
      data: { referenceId: giftId },
    });

    // ── Invalidate caches ────────────────
    await Promise.all([
      redis.del(GiftCacheKeys.receivedGifts(toUserId)),
      redis.del(GiftCacheKeys.sentGifts(fromUserId)),
    ]);

    // ── Emit event (triggers push notification) ──
    await EventBus.emit("gift.sent", {
      giftId,
      fromUserId,
      toUserId,
      starsAmount: starsAmount.toString(),
      animationId,
      message,
    });

    return { giftId, lockId, expiresAt };
  }

  // ─────────────────────────────────────
  // CLAIM GIFT
  // Recipient accepts → stars credited to their wallet
  // ─────────────────────────────────────
  async claimGift(
    userId: string,
    giftId: string
  ): Promise<{
    starsReceived: bigint;
    newBalance: bigint;
    transactionId: string;
  }> {
    const gift = await prisma.starsGift.findUnique({
      where: { id: giftId },
      include: { animation: true },
    });

    // ── Validations ─────────────────────
    if (!gift) {
      throw new AppError("GIFT_NOT_FOUND", "Gift not found", 404);
    }
    if (gift.toUserId !== userId) {
      throw new AppError("NOT_YOUR_GIFT", "This gift is not for you", 403);
    }
    if (gift.status !== GiftStatus.PENDING) {
      throw new AppError(
        "GIFT_NOT_CLAIMABLE",
        `Gift is already ${gift.status.toLowerCase()}`,
        409,
        { currentStatus: gift.status }
      );
    }
    if (gift.expiresAt < new Date()) {
      throw new AppError("GIFT_EXPIRED", "This gift has expired", 410);
    }

    // ── Find the lock ────────────────────
    const lock = await prisma.starsLock.findFirst({
      where: {
        referenceId: giftId,
        isReleased: false,
        userId: gift.fromUserId,
      },
    });

    if (!lock) {
      throw new AppError(
        "GIFT_LOCK_NOT_FOUND",
        "Gift stars are no longer locked — please contact support",
        500
      );
    }

    // ── Commit locked stars to recipient ─
    const commitResult = await starsWalletService.commitLockedStars(
      lock.id,
      userId,
      StarsTransactionType.GIFT_CLAIM,
      {
        referenceId: giftId,
        referenceType: "gift",
        description: `Gift received${gift.animation ? ` with ${gift.animation.displayName}` : ""}`,
        platformFeePercent: 0, // No fee on gifts — full amount to recipient
      }
    );

    // ── Update gift status ───────────────
    await prisma.starsGift.update({
      where: { id: giftId },
      data: {
        status: GiftStatus.CLAIMED,
        claimedAt: new Date(),
      },
    });

    // ── Invalidate caches ────────────────
    await Promise.all([
      redis.del(GiftCacheKeys.receivedGifts(userId)),
      redis.del(GiftCacheKeys.sentGifts(gift.fromUserId)),
      redis.del(GiftCacheKeys.giftDetails(giftId)),
    ]);

    // ── Emit event ───────────────────────
    await EventBus.emit("gift.claimed", {
      giftId,
      fromUserId: gift.fromUserId,
      toUserId: userId,
      starsAmount: gift.starsAmount.toString(),
    });

    return {
      starsReceived: commitResult.netAmount,
      newBalance: commitResult.netAmount, // caller should fetch actual balance
      transactionId: commitResult.transactionId,
    };
  }

  // ─────────────────────────────────────
  // REJECT GIFT
  // Recipient rejects → stars returned to sender
  // ─────────────────────────────────────
  async rejectGift(userId: string, giftId: string): Promise<void> {
    const gift = await prisma.starsGift.findUnique({
      where: { id: giftId },
    });

    if (!gift) throw new AppError("GIFT_NOT_FOUND", "Gift not found", 404);
    if (gift.toUserId !== userId) {
      throw new AppError("NOT_YOUR_GIFT", "This gift is not for you", 403);
    }
    if (gift.status !== GiftStatus.PENDING) {
      throw new AppError(
        "GIFT_NOT_REJECTABLE",
        `Gift is already ${gift.status.toLowerCase()}`,
        409
      );
    }

    // ── Find and release the lock ────────
    const lock = await prisma.starsLock.findFirst({
      where: {
        referenceId: giftId,
        isReleased: false,
        userId: gift.fromUserId,
      },
    });

    if (!lock) {
      throw new AppError("LOCK_NOT_FOUND", "Could not find gift lock", 500);
    }

    // ── Unlock stars → back to sender ────
    await starsWalletService.unlockStars(lock.id);

    // ── Update gift status ───────────────
    await prisma.starsGift.update({
      where: { id: giftId },
      data: {
        status: GiftStatus.REJECTED,
        rejectedAt: new Date(),
      },
    });

    // ── Invalidate caches ────────────────
    await Promise.all([
      redis.del(GiftCacheKeys.receivedGifts(userId)),
      redis.del(GiftCacheKeys.sentGifts(gift.fromUserId)),
      redis.del(GiftCacheKeys.giftDetails(giftId)),
    ]);

    await EventBus.emit("gift.rejected", {
      giftId,
      fromUserId: gift.fromUserId,
      toUserId: userId,
      starsRefunded: gift.starsAmount.toString(),
    });
  }

  // ─────────────────────────────────────
  // GET RECEIVED GIFTS
  // ─────────────────────────────────────
  async getReceivedGifts(
    userId: string,
    options: {
      status?: GiftStatus;
      page?: number;
      limit?: number;
    } = {}
  ) {
    const page = options.page ?? 1;
    const limit = Math.min(options.limit ?? 20, 100);
    const skip = (page - 1) * limit;

    const where: any = { toUserId: userId };
    if (options.status) where.status = options.status;

    const [gifts, total] = await Promise.all([
      prisma.starsGift.findMany({
        where,
        include: {
          animation: {
            select: {
              name: true,
              displayName: true,
              lottieUrl: true,
              thumbnailUrl: true,
              rarity: true,
            },
          },
        },
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
      }),
      prisma.starsGift.count({ where }),
    ]);

    return {
      gifts: gifts.map((g) => ({
        ...g,
        starsAmount: g.starsAmount.toString(),
      })),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
        hasMore: page * limit < total,
      },
    };
  }

  // ─────────────────────────────────────
  // GET SENT GIFTS
  // ─────────────────────────────────────
  async getSentGifts(
    userId: string,
    options: { page?: number; limit?: number } = {}
  ) {
    const page = options.page ?? 1;
    const limit = Math.min(options.limit ?? 20, 100);
    const skip = (page - 1) * limit;

    const [gifts, total] = await Promise.all([
      prisma.starsGift.findMany({
        where: { fromUserId: userId },
        include: {
          animation: {
            select: {
              name: true,
              displayName: true,
              thumbnailUrl: true,
              rarity: true,
            },
          },
        },
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
      }),
      prisma.starsGift.count({ where: { fromUserId: userId } }),
    ]);

    return {
      gifts: gifts.map((g) => ({
        ...g,
        starsAmount: g.starsAmount.toString(),
      })),
      pagination: { page, limit, total, hasMore: page * limit < total },
    };
  }

  // ─────────────────────────────────────
  // GET GIFT ANIMATIONS CATALOG
  // ─────────────────────────────────────
  async getAnimations(category?: string) {
    const cacheKey = GiftCacheKeys.animations();
    const cached = await redis.get(cacheKey);
    if (cached && !category) return JSON.parse(cached);

    const where: any = { isAvailable: true };
    if (category) where.category = category;

    const now = new Date();
    where.OR = [
      { availableUntil: null },
      { availableUntil: { gt: now } },
    ];

    const animations = await prisma.giftAnimation.findMany({
      where,
      orderBy: [{ rarity: "asc" }, { sortOrder: "asc" }],
    });

    const result = animations.map((a) => ({
      ...a,
      priceStars: a.priceStars.toString(),
    }));

    if (!category) {
      await redis.setex(cacheKey, 3600, JSON.stringify(result));
    }

    return result;
  }

  // ─────────────────────────────────────
  // GET SINGLE GIFT DETAILS
  // ─────────────────────────────────────
  async getGiftDetails(
    giftId: string,
    requestingUserId: string
  ): Promise<GiftDetails> {
    const gift = await prisma.starsGift.findUnique({
      where: { id: giftId },
      include: {
        animation: {
          select: {
            name: true,
            displayName: true,
            lottieUrl: true,
            rarity: true,
          },
        },
      },
    });

    if (!gift) throw new AppError("GIFT_NOT_FOUND", "Gift not found", 404);

    // Only sender or recipient can view gift details
    if (
      gift.fromUserId !== requestingUserId &&
      gift.toUserId !== requestingUserId
    ) {
      throw new AppError("FORBIDDEN", "You cannot view this gift", 403);
    }

    return {
      id: gift.id,
      fromUserId: gift.fromUserId,
      toUserId: gift.toUserId,
      starsAmount: gift.starsAmount,
      message: gift.message,
      status: gift.status,
      animation: gift.animation
        ? {
            name: gift.animation.name,
            displayName: gift.animation.displayName,
            lottieUrl: gift.animation.lottieUrl,
            rarity: gift.animation.rarity,
          }
        : null,
      claimedAt: gift.claimedAt,
      expiresAt: gift.expiresAt,
      createdAt: gift.createdAt,
    };
  }

  // ─────────────────────────────────────
  // PRIVATE: Daily gift limit checks
  // ─────────────────────────────────────
  private async checkDailyGiftLimits(
    fromUserId: string,
    toUserId: string
  ): Promise<void> {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const [sentToday, receivedToday] = await Promise.all([
      prisma.starsGift.count({
        where: {
          fromUserId,
          createdAt: { gte: today },
        },
      }),
      prisma.starsGift.count({
        where: {
          toUserId,
          createdAt: { gte: today },
        },
      }),
    ]);

    if (sentToday >= GIFT_CONFIG.MAX_DAILY_GIFTS_SENT) {
      throw new AppError(
        "DAILY_GIFT_LIMIT",
        `You can only send ${GIFT_CONFIG.MAX_DAILY_GIFTS_SENT} gifts per day`,
        429
      );
    }

    if (receivedToday >= GIFT_CONFIG.MAX_DAILY_GIFTS_RECEIVED) {
      throw new AppError(
        "RECIPIENT_GIFT_LIMIT",
        "Recipient has reached their daily gift limit",
        429
      );
    }
  }
}

export const starsGiftService = new StarsGiftService();
