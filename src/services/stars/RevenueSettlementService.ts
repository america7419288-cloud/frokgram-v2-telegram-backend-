import {
  SettlementStatus,
  StarsTransactionType,
} from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { starsWalletService } from "./StarsWalletService";
import { EventBus } from "../../lib/eventBus";
import logger from "../../lib/logger";

// ─────────────────────────────────────────
// Revenue Settlement Service
// Batches small revenue events and
// settles them to creator wallets hourly
// ─────────────────────────────────────────
export class RevenueSettlementService {

  // ─────────────────────────────────────
  // QUEUE SETTLEMENT
  // Called when revenue is earned
  // Does NOT immediately credit wallet
  // ─────────────────────────────────────
  async queueSettlement(
    creatorId: string,
    sourceType: string,
    sourceId: string,
    grossAmount: bigint,
    platformFee: bigint,
    netAmount: bigint
  ): Promise<string> {
    const settlement = await prisma.revenueSettlement.create({
      data: {
        creatorId,
        sourceType,
        sourceId,
        grossAmount,
        platformFee,
        netAmount,
        status: SettlementStatus.PENDING,
      },
    });
    return settlement.id;
  }

  // ─────────────────────────────────────
  // PROCESS PENDING SETTLEMENTS
  // Called by cron job every hour
  // Groups by creator and credits wallet
  // ─────────────────────────────────────
  async processPendingSettlements(): Promise<{
    processed: number;
    failed: number;
    totalStarsSettled: bigint;
  }> {
    // Group pending settlements by creator
    const pendingByCreator = await prisma.revenueSettlement.groupBy({
      by: ["creatorId"],
      where: { status: SettlementStatus.PENDING },
      _sum: { netAmount: true },
      _count: { id: true },
    });

    let processed = 0;
    let failed = 0;
    let totalStarsSettled = BigInt(0);

    for (const creatorGroup of pendingByCreator) {
      try {
        const { creatorId } = creatorGroup;
        const totalNet = creatorGroup._sum.netAmount ?? BigInt(0);

        if (totalNet <= BigInt(0)) continue;

        // Get all pending settlement IDs for this creator
        const pendingIds = await prisma.revenueSettlement.findMany({
          where: {
            creatorId,
            status: SettlementStatus.PENDING,
          },
          select: { id: true },
        });

        await prisma.$transaction(async (tx) => {
          // Mark as processing
          await tx.revenueSettlement.updateMany({
            where: {
              id: { in: pendingIds.map((s) => s.id) },
            },
            data: { status: SettlementStatus.PROCESSING },
          });

          // Credit creator wallet
          await starsWalletService.creditStars(
            creatorId,
            totalNet,
            StarsTransactionType.PLATFORM_FEE, // net after fee
            {
              description: `Revenue settlement: ${creatorGroup._count.id} events`,
              metadata: {
                settlementIds: pendingIds.map((s) => s.id),
                count: creatorGroup._count.id,
              },
            }
          );

          // Mark as settled
          await tx.revenueSettlement.updateMany({
            where: {
              id: { in: pendingIds.map((s) => s.id) },
            },
            data: {
              status: SettlementStatus.SETTLED,
              settledAt: new Date(),
            },
          });
        });

        processed++;
        totalStarsSettled += totalNet;

        await EventBus.emit("revenue.settled", {
          creatorId,
          amount: totalNet.toString(),
          eventCount: creatorGroup._count.id,
        });
      } catch (err) {
        failed++;
        logger.error(
          `❌ Settlement failed for creator ${creatorGroup.creatorId}:`,
          err
        );

        // Mark as failed
        await prisma.revenueSettlement.updateMany({
          where: {
            creatorId: creatorGroup.creatorId,
            status: SettlementStatus.PROCESSING,
          },
          data: { status: SettlementStatus.FAILED },
        });
      }
    }

    logger.info(
      `✅ Settlement complete: ${processed} creators, ${totalStarsSettled} stars`
    );

    return { processed, failed, totalStarsSettled };
  }

  // ─────────────────────────────────────
  // GET CREATOR PENDING BALANCE
  // Stars earned but not yet settled
  // ─────────────────────────────────────
  async getPendingBalance(creatorId: string): Promise<{
    pendingAmount: bigint;
    pendingCount: number;
    estimatedSettlementAt: Date;
  }> {
    const pending = await prisma.revenueSettlement.aggregate({
      where: {
        creatorId,
        status: SettlementStatus.PENDING,
      },
      _sum: { netAmount: true },
      _count: { id: true },
    });

    // Next settlement runs at the top of next hour
    const now = new Date();
    const nextHour = new Date(now);
    nextHour.setHours(now.getHours() + 1, 0, 0, 0);

    return {
      pendingAmount: pending._sum.netAmount ?? BigInt(0),
      pendingCount: pending._count.id,
      estimatedSettlementAt: nextHour,
    };
  }

  // ─────────────────────────────────────
  // GET SETTLEMENT HISTORY
  // ─────────────────────────────────────
  async getSettlementHistory(
    creatorId: string,
    options: { page?: number; limit?: number } = {}
  ) {
    const page = options.page ?? 1;
    const limit = Math.min(options.limit ?? 20, 100);

    const [settlements, total] = await Promise.all([
      prisma.revenueSettlement.findMany({
        where: { creatorId, status: SettlementStatus.SETTLED },
        orderBy: { settledAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.revenueSettlement.count({
        where: { creatorId, status: SettlementStatus.SETTLED },
      }),
    ]);

    return {
      settlements: settlements.map((s) => ({
        ...s,
        grossAmount: s.grossAmount.toString(),
        platformFee: s.platformFee.toString(),
        netAmount: s.netAmount.toString(),
      })),
      pagination: {
        page, limit, total,
        hasMore: page * limit < total,
      },
    };
  }
}

export const revenueSettlementService = new RevenueSettlementService();
