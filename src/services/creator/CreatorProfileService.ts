import { AppError } from "../../lib/errors";
import { EventBus } from "../../lib/eventBus";
import { redis } from "../../lib/redis";
import { prisma } from "../../lib/prisma";

// ─────────────────────────────────────────
// Types
// ─────────────────────────────────────────
export interface CreatorProfileData {
  displayName?: string;
  bio?: string;
  category?: string;
}

export interface DashboardStats {
  totalEarned: bigint;
  totalWithdrawn: bigint;
  pendingBalance: bigint;
  availableBalance: bigint;
  subscriberCount: number;
  thisMonthEarned: bigint;
  lastMonthEarned: bigint;
  todayEarned: bigint;
  thisWeekEarned: bigint;
  earningsBySource: Record<string, bigint>;
  recentEarnings: any[];
}

// ─────────────────────────────────────────
// Cache Keys
// ─────────────────────────────────────────
const CreatorCacheKeys = {
  profile: (userId: string) => `creator:profile:${userId}`,
  dashboard: (userId: string) => `creator:dashboard:${userId}`,
  analytics: (userId: string, period: string) =>
    `creator:analytics:${userId}:${period}`,
} as const;

// ─────────────────────────────────────────
// Creator Profile Service
// ─────────────────────────────────────────
export class CreatorProfileService {

  // ─────────────────────────────────────
  // GET OR CREATE CREATOR PROFILE
  // ─────────────────────────────────────
  async getOrCreateProfile(userId: string) {
    const existing = await prisma.creatorProfile.findUnique({
      where: { userId },
      include: {
        payoutMethods: { where: { isDefault: true }, take: 1 },
        taxInfo: { select: { isSubmitted: true, isVerified: true } },
      },
    });

    if (existing) return existing;

    const profile = await prisma.creatorProfile.create({
      data: {
        userId,
        isMonetizationEnabled: false,
        totalEarned: BigInt(0),
        totalWithdrawn: BigInt(0),
        pendingBalance: BigInt(0),
        availableBalance: BigInt(0),
        subscriberCount: 0,
      },
      include: {
        payoutMethods: true,
        taxInfo: true,
      },
    });

    await EventBus.emit("creator.profile_created", { userId });
    return profile;
  }

  // ─────────────────────────────────────
  // UPDATE CREATOR PROFILE
  // ─────────────────────────────────────
  async updateProfile(
    userId: string,
    data: CreatorProfileData
  ): Promise<void> {
    await prisma.creatorProfile.upsert({
      where: { userId },
      update: { ...data, updatedAt: new Date() },
      create: {
        userId,
        ...data,
        isMonetizationEnabled: false,
      },
    });

    await redis.del(CreatorCacheKeys.profile(userId));
  }

  // ─────────────────────────────────────
  // ENABLE MONETIZATION
  // ─────────────────────────────────────
  async enableMonetization(userId: string): Promise<void> {
    const profile = await this.getOrCreateProfile(userId);

    // Check requirements
    if (profile.isMonetizationEnabled) {
      throw new AppError(
        "ALREADY_ENABLED",
        "Monetization is already enabled",
        409
      );
    }

    // Basic checks before enabling
    const checks = {
      hasPayoutMethod: profile.payoutMethods.length > 0,
      hasProfile: !!profile.displayName,
    };

    const failedChecks = Object.entries(checks)
      .filter(([, passed]) => !passed)
      .map(([key]) => key);

    if (failedChecks.length > 0) {
      throw new AppError(
        "REQUIREMENTS_NOT_MET",
        "Please complete your profile setup before enabling monetization",
        400,
        { failedChecks }
      );
    }

    await prisma.creatorProfile.update({
      where: { userId },
      data: { isMonetizationEnabled: true },
    });

    await redis.del(CreatorCacheKeys.profile(userId));
    await EventBus.emit("creator.monetization_enabled", { userId });
  }

  // ─────────────────────────────────────
  // GET DASHBOARD STATS
  // ─────────────────────────────────────
  async getDashboardStats(userId: string): Promise<DashboardStats> {
    const cacheKey = CreatorCacheKeys.dashboard(userId);
    const cached = await redis.get(cacheKey);
    if (cached) {
      const parsed = JSON.parse(cached);
      return {
        ...parsed,
        totalEarned: BigInt(parsed.totalEarned),
        totalWithdrawn: BigInt(parsed.totalWithdrawn),
        pendingBalance: BigInt(parsed.pendingBalance),
        availableBalance: BigInt(parsed.availableBalance),
        thisMonthEarned: BigInt(parsed.thisMonthEarned),
        lastMonthEarned: BigInt(parsed.lastMonthEarned),
        todayEarned: BigInt(parsed.todayEarned),
        thisWeekEarned: BigInt(parsed.thisWeekEarned),
        earningsBySource: Object.fromEntries(
          Object.entries(parsed.earningsBySource).map(([k, v]) => [k, BigInt(v as string)])
        ),
      };
    }

    const profile = await this.getOrCreateProfile(userId);

    const now = new Date();

    // Date ranges
    const todayStart = new Date(now);
    todayStart.setHours(0, 0, 0, 0);

    const weekStart = new Date(now);
    weekStart.setDate(now.getDate() - 7);

    const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const lastMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0);

    // Run all queries in parallel
    const [
      todayEarnings,
      weekEarnings,
      thisMonthEarnings,
      lastMonthEarnings,
      bySource,
      recentEarnings,
    ] = await Promise.all([
      // Today earnings
      prisma.creatorEarning.aggregate({
        where: { creatorId: profile.id, createdAt: { gte: todayStart } },
        _sum: { netAmount: true },
      }),

      // This week earnings
      prisma.creatorEarning.aggregate({
        where: { creatorId: profile.id, createdAt: { gte: weekStart } },
        _sum: { netAmount: true },
      }),

      // This month earnings
      prisma.creatorEarning.aggregate({
        where: { creatorId: profile.id, createdAt: { gte: thisMonthStart } },
        _sum: { netAmount: true },
      }),

      // Last month earnings
      prisma.creatorEarning.aggregate({
        where: {
          creatorId: profile.id,
          createdAt: { gte: lastMonthStart, lte: lastMonthEnd },
        },
        _sum: { netAmount: true },
      }),

      // Earnings by source type
      prisma.creatorEarning.groupBy({
        by: ["sourceType"],
        where: { creatorId: profile.id },
        _sum: { netAmount: true },
      }),

      // Recent earnings (last 10)
      prisma.creatorEarning.findMany({
        where: { creatorId: profile.id },
        orderBy: { createdAt: "desc" },
        take: 10,
      }),
    ]);

    // Build earnings by source map
    const earningsBySource: Record<string, bigint> = {};
    for (const group of bySource) {
      earningsBySource[group.sourceType] =
        group._sum.netAmount ?? BigInt(0);
    }

    const stats: DashboardStats = {
      totalEarned: profile.totalEarned,
      totalWithdrawn: profile.totalWithdrawn,
      pendingBalance: profile.pendingBalance,
      availableBalance: profile.availableBalance,
      subscriberCount: profile.subscriberCount,
      todayEarned: todayEarnings._sum.netAmount ?? BigInt(0),
      thisWeekEarned: weekEarnings._sum.netAmount ?? BigInt(0),
      thisMonthEarned: thisMonthEarnings._sum.netAmount ?? BigInt(0),
      lastMonthEarned: lastMonthEarnings._sum.netAmount ?? BigInt(0),
      earningsBySource,
      recentEarnings: recentEarnings.map((e) => ({
        ...e,
        grossAmount: e.grossAmount.toString(),
        platformFee: e.platformFee.toString(),
        netAmount: e.netAmount.toString(),
      })),
    };

    // Cache for 5 minutes
    await redis.setex(
      cacheKey,
      300,
      JSON.stringify({
        ...stats,
        totalEarned: stats.totalEarned.toString(),
        totalWithdrawn: stats.totalWithdrawn.toString(),
        pendingBalance: stats.pendingBalance.toString(),
        availableBalance: stats.availableBalance.toString(),
        todayEarned: stats.todayEarned.toString(),
        thisWeekEarned: stats.thisWeekEarned.toString(),
        thisMonthEarned: stats.thisMonthEarned.toString(),
        lastMonthEarned: stats.lastMonthEarned.toString(),
        earningsBySource: Object.fromEntries(
          Object.entries(stats.earningsBySource).map(([k, v]) => [k, v.toString()])
        ),
      })
    );

    return stats;
  }

  // ─────────────────────────────────────
  // RECORD EARNING
  // Called when a revenue event happens
  // Updates creator's pending balance
  // ─────────────────────────────────────
  async recordEarning(
    userId: string,
    sourceType: string,
    sourceId: string,
    grossAmount: bigint,
    platformFeeRate: number,
    platformFee: bigint,
    netAmount: bigint
  ): Promise<void> {
    const profile = await this.getOrCreateProfile(userId);

    const now = new Date();
    const period = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

    await prisma.$transaction(async (tx) => {
      // Create earning record
      await tx.creatorEarning.create({
        data: {
          creatorId: profile.id,
          sourceType: sourceType as any,
          sourceId,
          grossAmount,
          platformFeeRate,
          platformFee,
          netAmount,
          period,
        },
      });

      // Update creator profile balances
      await tx.creatorProfile.update({
        where: { id: profile.id },
        data: {
          totalEarned: { increment: netAmount },
          pendingBalance: { increment: netAmount },
        },
      });
    });

    // Invalidate cache
    await redis.del(CreatorCacheKeys.dashboard(userId));
  }

  // ─────────────────────────────────────
  // SETTLE PENDING TO AVAILABLE
  // Move pending balance → available balance
  // Called after revenue settlement runs
  // ─────────────────────────────────────
  async settlePendingToAvailable(
    userId: string,
    amount: bigint
  ): Promise<void> {
    const profile = await prisma.creatorProfile.findUnique({
      where: { userId },
    });

    if (!profile) return;
    if (profile.pendingBalance < amount) {
      amount = profile.pendingBalance; // settle what we have
    }

    await prisma.creatorProfile.update({
      where: { userId },
      data: {
        pendingBalance: { decrement: amount },
        availableBalance: { increment: amount },
      },
    });

    await redis.del(CreatorCacheKeys.dashboard(userId));
  }

  // ─────────────────────────────────────
  // GET EARNINGS HISTORY (paginated)
  // ─────────────────────────────────────
  async getEarningsHistory(
    userId: string,
    options: {
      page?: number;
      limit?: number;
      sourceType?: string;
      period?: string;
      startDate?: Date;
      endDate?: Date;
    } = {}
  ) {
    const profile = await this.getOrCreateProfile(userId);
    const page = options.page ?? 1;
    const limit = Math.min(options.limit ?? 20, 100);

    const where: any = { creatorId: profile.id };
    if (options.sourceType) where.sourceType = options.sourceType;
    if (options.period) where.period = options.period;
    if (options.startDate || options.endDate) {
      where.createdAt = {};
      if (options.startDate) where.createdAt.gte = options.startDate;
      if (options.endDate) where.createdAt.lte = options.endDate;
    }

    const [earnings, total] = await Promise.all([
      prisma.creatorEarning.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.creatorEarning.count({ where }),
    ]);

    return {
      earnings: earnings.map((e) => ({
        ...e,
        grossAmount: e.grossAmount.toString(),
        platformFee: e.platformFee.toString(),
        netAmount: e.netAmount.toString(),
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
  // GET TOP CONTENT
  // Which posts/stories earned the most
  // ─────────────────────────────────────
  async getTopContent(
    userId: string,
    sourceType: string,
    limit: number = 10
  ) {
    const profile = await this.getOrCreateProfile(userId);

    const topContent = await prisma.creatorEarning.groupBy({
      by: ["sourceId"],
      where: {
        creatorId: profile.id,
        sourceType: sourceType as any,
      },
      _sum: { netAmount: true, grossAmount: true },
      _count: { id: true },
      orderBy: { _sum: { netAmount: "desc" } },
      take: Math.min(limit, 50),
    });

    return topContent.map((item) => ({
      sourceId: item.sourceId,
      totalEarned: (item._sum.netAmount ?? BigInt(0)).toString(),
      grossEarned: (item._sum.grossAmount ?? BigInt(0)).toString(),
      eventCount: item._count.id,
    }));
  }

  // ─────────────────────────────────────
  // GET REVENUE CHART DATA
  // ─────────────────────────────────────
  async getRevenueChart(
    userId: string,
    period: "7d" | "30d" | "90d" | "1y",
    granularity: "day" | "week" | "month" = "day"
  ) {
    const profile = await this.getOrCreateProfile(userId);

    const days = { "7d": 7, "30d": 30, "90d": 90, "1y": 365 }[period];
    const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const earnings = await prisma.creatorEarning.findMany({
      where: {
        creatorId: profile.id,
        createdAt: { gte: startDate },
      },
      orderBy: { createdAt: "asc" },
      select: {
        netAmount: true,
        sourceType: true,
        createdAt: true,
      },
    });

    // Group by granularity
    const grouped = new Map<string, { total: bigint; bySource: Record<string, bigint> }>();

    for (const earning of earnings) {
      const key = this.getGranularityKey(earning.createdAt, granularity);
      if (!grouped.has(key)) {
        grouped.set(key, { total: BigInt(0), bySource: {} });
      }
      const entry = grouped.get(key)!;
      entry.total += earning.netAmount;
      entry.bySource[earning.sourceType] =
        (entry.bySource[earning.sourceType] ?? BigInt(0)) + earning.netAmount;
    }

    return Array.from(grouped.entries()).map(([date, data]) => ({
      date,
      total: data.total.toString(),
      bySource: Object.fromEntries(
        Object.entries(data.bySource).map(([k, v]) => [k, v.toString()])
      ),
    }));
  }

  // ─────────────────────────────────────
  // PRIVATE: Granularity key for grouping
  // ─────────────────────────────────────
  private getGranularityKey(
    date: Date,
    granularity: "day" | "week" | "month"
  ): string {
    switch (granularity) {
      case "day":
        return date.toISOString().split("T")[0]; // "2024-01-15"
      case "week": {
        const d = new Date(date);
        d.setDate(d.getDate() - d.getDay());
        return d.toISOString().split("T")[0]; // week start date
      }
      case "month":
        return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
    }
  }
}

export const creatorProfileService = new CreatorProfileService();
