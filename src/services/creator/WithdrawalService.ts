import { PayoutStatus } from "@prisma/client";
import { AppError } from "../../lib/errors";
import { EventBus } from "../../lib/eventBus";
import { starsWalletService } from "../stars/StarsWalletService";
import { StarsTransactionType } from "@prisma/client";
import { prisma } from "../../lib/prisma";

// ─────────────────────────────────────────
// Withdrawal Config
// ─────────────────────────────────────────
const WITHDRAWAL_CONFIG = {
  PLATFORM_FEE_PERCENT: 5,          // 5% withdrawal processing fee
  MIN_WITHDRAWAL_STARS: BigInt(1000),
  MAX_WITHDRAWAL_STARS: BigInt(1000000),
  MAX_PENDING_PAYOUTS: 3,           // max concurrent pending payouts
  PROCESSING_TIME_DAYS: 3,          // estimated days to complete
  AML_THRESHOLD_STARS: BigInt(50000), // flag for AML review
};

// ─────────────────────────────────────────
// Withdrawal / Payout Service
// ─────────────────────────────────────────
export class WithdrawalService {

  // ─────────────────────────────────────
  // REQUEST WITHDRAWAL
  // ─────────────────────────────────────
  async requestWithdrawal(
    userId: string,
    starsAmount: bigint,
    payoutMethodId: string
  ): Promise<{
    payoutId: string;
    starsAmount: bigint;
    platformFee: bigint;
    netStars: bigint;
    estimatedFiatAmount: number;
    estimatedCompletionDate: Date;
  }> {
    // ── Validations ─────────────────────
    if (starsAmount < WITHDRAWAL_CONFIG.MIN_WITHDRAWAL_STARS) {
      throw new AppError(
        "BELOW_MINIMUM",
        `Minimum withdrawal is ${WITHDRAWAL_CONFIG.MIN_WITHDRAWAL_STARS} stars`,
        400,
        { minimum: WITHDRAWAL_CONFIG.MIN_WITHDRAWAL_STARS.toString() }
      );
    }
    if (starsAmount > WITHDRAWAL_CONFIG.MAX_WITHDRAWAL_STARS) {
      throw new AppError(
        "ABOVE_MAXIMUM",
        `Maximum single withdrawal is ${WITHDRAWAL_CONFIG.MAX_WITHDRAWAL_STARS} stars`,
        400
      );
    }

    // ── Get creator profile ──────────────
    const profile = await prisma.creatorProfile.findUnique({
      where: { userId },
    });
    if (!profile) {
      throw new AppError("PROFILE_NOT_FOUND", "Creator profile not found", 404);
    }
    if (!profile.isMonetizationEnabled) {
      throw new AppError(
        "MONETIZATION_DISABLED",
        "Enable monetization before withdrawing",
        403
      );
    }

    // ── Check available balance ──────────
    if (profile.availableBalance < starsAmount) {
      throw new AppError(
        "INSUFFICIENT_BALANCE",
        "Insufficient available balance",
        402,
        {
          requested: starsAmount.toString(),
          available: profile.availableBalance.toString(),
          pending: profile.pendingBalance.toString(),
        }
      );
    }

    // ── Check pending payout limit ───────
    const pendingCount = await prisma.creatorPayout.count({
      where: {
        creatorId: profile.id,
        status: {
          in: [PayoutStatus.PENDING, PayoutStatus.APPROVED, PayoutStatus.PROCESSING],
        },
      },
    });
    if (pendingCount >= WITHDRAWAL_CONFIG.MAX_PENDING_PAYOUTS) {
      throw new AppError(
        "TOO_MANY_PENDING",
        "You have too many pending payouts. Please wait for them to complete.",
        429,
        { maxPending: WITHDRAWAL_CONFIG.MAX_PENDING_PAYOUTS }
      );
    }

    // ── Verify payout method ─────────────
    const payoutMethod = await prisma.creatorPayoutMethod.findFirst({
      where: { id: payoutMethodId, creatorId: profile.id },
    });
    if (!payoutMethod) {
      throw new AppError(
        "METHOD_NOT_FOUND",
        "Payout method not found",
        404
      );
    }
    if (starsAmount < payoutMethod.minPayoutStars) {
      throw new AppError(
        "BELOW_METHOD_MINIMUM",
        `Minimum for this payout method is ${payoutMethod.minPayoutStars} stars`,
        400
      );
    }

    // ── AML check ───────────────────────
    await this.runAmlChecks(userId, profile.id, starsAmount);

    // ── Calculate fees ───────────────────
    const platformFee =
      (starsAmount * BigInt(WITHDRAWAL_CONFIG.PLATFORM_FEE_PERCENT)) / BigInt(100);
    const netStars = starsAmount - platformFee;

    // ── Get exchange rate ────────────────
    const exchangeRate = await this.getCurrentExchangeRate();
    const estimatedFiatAmount = Number(netStars) / Number(exchangeRate.starsPerUsd);

    // ── Create payout request ────────────
    const payout = await prisma.$transaction(async (tx) => {
      // Deduct from available balance
      await tx.creatorProfile.update({
        where: { id: profile.id },
        data: {
          availableBalance: { decrement: starsAmount },
          totalWithdrawn: { increment: netStars },
        },
      });

      // Also debit from stars wallet
      await starsWalletService.debitStars(
        userId,
        starsAmount,
        StarsTransactionType.WITHDRAWAL,
        {
          referenceType: "withdrawal",
          description: `Withdrawal of ${starsAmount} stars`,
          metadata: {
            payoutMethodId,
            platformFee: platformFee.toString(),
            netStars: netStars.toString(),
          },
        }
      );

      // Create payout record
      return tx.creatorPayout.create({
        data: {
          creatorId: profile.id,
          payoutMethodId,
          starsAmount,
          fiatAmount: estimatedFiatAmount,
          fiatCurrency: "USD",
          exchangeRate: 1 / Number(exchangeRate.starsPerUsd),
          platformFee,
          netStars,
          status: PayoutStatus.PENDING,
        },
      });
    });

    const estimatedCompletionDate = new Date(
      Date.now() +
        WITHDRAWAL_CONFIG.PROCESSING_TIME_DAYS * 24 * 60 * 60 * 1000
    );

    await EventBus.emit("withdrawal.requested", {
      userId,
      payoutId: payout.id,
      starsAmount: starsAmount.toString(),
      netStars: netStars.toString(),
      payoutMethod: payoutMethod.type,
    });

    return {
      payoutId: payout.id,
      starsAmount,
      platformFee,
      netStars,
      estimatedFiatAmount,
      estimatedCompletionDate,
    };
  }

  // ─────────────────────────────────────
  // CANCEL WITHDRAWAL
  // Can only cancel PENDING payouts
  // ─────────────────────────────────────
  async cancelWithdrawal(userId: string, payoutId: string): Promise<void> {
    const profile = await prisma.creatorProfile.findUnique({
      where: { userId },
    });
    if (!profile) throw new AppError("PROFILE_NOT_FOUND", "Profile not found", 404);

    const payout = await prisma.creatorPayout.findFirst({
      where: { id: payoutId, creatorId: profile.id },
    });
    if (!payout) {
      throw new AppError("PAYOUT_NOT_FOUND", "Payout not found", 404);
    }
    if (payout.status !== PayoutStatus.PENDING) {
      throw new AppError(
        "CANNOT_CANCEL",
        `Cannot cancel a payout with status: ${payout.status}`,
        409
      );
    }

    await prisma.$transaction(async (tx) => {
      // Refund to available balance
      await tx.creatorProfile.update({
        where: { id: profile.id },
        data: {
          availableBalance: { increment: payout.starsAmount },
          totalWithdrawn: { decrement: payout.netStars },
        },
      });

      // Refund to stars wallet
      await starsWalletService.creditStars(
        userId,
        payout.starsAmount,
        StarsTransactionType.REFUND,
        {
          referenceId: payoutId,
          referenceType: "withdrawal_cancellation",
          description: "Withdrawal cancelled — stars refunded",
        }
      );

      // Update payout status
      await tx.creatorPayout.update({
        where: { id: payoutId },
        data: { status: PayoutStatus.CANCELLED },
      });
    });

    await EventBus.emit("withdrawal.cancelled", {
      userId,
      payoutId,
      refundedAmount: payout.starsAmount.toString(),
    });
  }

  // ─────────────────────────────────────
  // GET PAYOUT HISTORY
  // ─────────────────────────────────────
  async getPayoutHistory(
    userId: string,
    options: {
      page?: number;
      limit?: number;
      status?: PayoutStatus;
    } = {}
  ) {
    const profile = await prisma.creatorProfile.findUnique({
      where: { userId },
    });
    if (!profile) return { payouts: [], pagination: { page: 1, limit: 20, total: 0 } };

    const page = options.page ?? 1;
    const limit = Math.min(options.limit ?? 20, 100);
    const where: any = { creatorId: profile.id };
    if (options.status) where.status = options.status;

    const [payouts, total] = await Promise.all([
      prisma.creatorPayout.findMany({
        where,
        include: {
          payoutMethod: {
            select: {
              type: true,
              tonAddress: true,
              paypalEmail: true,
              bankName: true,
              bankAccountNum: true,
            },
          },
        },
        orderBy: { requestedAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.creatorPayout.count({ where }),
    ]);

    return {
      payouts: payouts.map((p) => ({
        ...p,
        starsAmount: p.starsAmount.toString(),
        platformFee: p.platformFee.toString(),
        netStars: p.netStars.toString(),
        fiatAmount: p.fiatAmount?.toString(),
      })),
      pagination: {
        page, limit, total,
        totalPages: Math.ceil(total / limit),
        hasMore: page * limit < total,
      },
    };
  }

  // ─────────────────────────────────────
  // GET PAYOUT STATUS
  // ─────────────────────────────────────
  async getPayoutStatus(
    userId: string,
    payoutId: string
  ): Promise<{
    status: PayoutStatus;
    providerTxId: string | null;
    processedAt: Date | null;
    completedAt: Date | null;
    failureReason: string | null;
  }> {
    const profile = await prisma.creatorProfile.findUnique({
      where: { userId },
    });
    if (!profile) throw new AppError("PROFILE_NOT_FOUND", "Profile not found", 404);

    const payout = await prisma.creatorPayout.findFirst({
      where: { id: payoutId, creatorId: profile.id },
    });
    if (!payout) throw new AppError("PAYOUT_NOT_FOUND", "Payout not found", 404);

    return {
      status: payout.status,
      providerTxId: payout.providerTxId,
      processedAt: payout.processedAt,
      completedAt: payout.completedAt,
      failureReason: payout.failureReason,
    };
  }

  // ─────────────────────────────────────
  // PROCESS PAYOUTS (called by cron)
  // Admin-triggered batch processing
  // ─────────────────────────────────────
  async processApprovedPayouts(): Promise<{
    processed: number;
    failed: number;
  }> {
    const approvedPayouts = await prisma.creatorPayout.findMany({
      where: { status: PayoutStatus.APPROVED },
      include: {
        payoutMethod: true,
        creator: { select: { userId: true } },
      },
      take: 50,
    });

    let processed = 0;
    let failed = 0;

    for (const payout of approvedPayouts) {
      try {
        await prisma.creatorPayout.update({
          where: { id: payout.id },
          data: {
            status: PayoutStatus.PROCESSING,
            processedAt: new Date(),
          },
        });

        // Process based on method type
        const txId = await this.executePayment(payout);

        await prisma.creatorPayout.update({
          where: { id: payout.id },
          data: {
            status: PayoutStatus.COMPLETED,
            completedAt: new Date(),
            providerTxId: txId,
          },
        });

        await EventBus.emit("withdrawal.completed", {
          userId: payout.creator.userId,
          payoutId: payout.id,
          netStars: payout.netStars.toString(),
          txId,
        });

        processed++;
      } catch (err) {
        failed++;
        await prisma.creatorPayout.update({
          where: { id: payout.id },
          data: {
            status: PayoutStatus.FAILED,
            failureReason: (err as Error).message,
          },
        });

        await EventBus.emit("withdrawal.failed", {
          payoutId: payout.id,
          reason: (err as Error).message,
        });
      }
    }

    return { processed, failed };
  }

  // ─────────────────────────────────────
  // PRIVATE: Execute actual payment
  // ─────────────────────────────────────
  private async executePayment(payout: any): Promise<string> {
    switch (payout.payoutMethod.type) {
      case "TON_WALLET":
        return this.sendTonPayment(
          payout.payoutMethod.tonAddress,
          Number(payout.netStars)
        );

      case "BANK_TRANSFER":
        // Integrate with your banking partner here
        return `BANK_REF_${payout.id}_${Date.now()}`;

      case "PAYPAL":
        // Integrate with PayPal Payouts API here
        return `PAYPAL_${payout.id}_${Date.now()}`;

      default:
        throw new AppError(
          "UNSUPPORTED_METHOD",
          `Payment method ${payout.payoutMethod.type} not yet implemented`,
          501
        );
    }
  }

  // ─────────────────────────────────────
  // PRIVATE: Send TON payment
  // ─────────────────────────────────────
  private async sendTonPayment(
    toAddress: string,
    starsAmount: number
  ): Promise<string> {
    // Convert stars to TON (example: 50 stars = 1 TON)
    const tonAmount = starsAmount / 50;

    // In real implementation: use @ton/ton SDK
    // const client = new TonClient({ endpoint: process.env.TON_ENDPOINT });
    // const keyPair = await mnemonicToPrivateKey(process.env.TON_MNEMONIC.split(" "));
    // const wallet = WalletContractV4.create({ publicKey: keyPair.publicKey, workchain: 0 });
    // const contract = client.open(wallet);
    // await contract.sendTransfer({ ... });

    console.log(`📤 Sending ${tonAmount} TON to ${toAddress}`);

    // Simulated for now
    return `TON_TX_${Date.now()}_${toAddress.slice(0, 8)}`;
  }

  // ─────────────────────────────────────
  // PRIVATE: Get current exchange rate
  // ─────────────────────────────────────
  private async getCurrentExchangeRate() {
    const rate = await prisma.starsExchangeRate.findFirst({
      where: { isActive: true },
      orderBy: { effectiveFrom: "desc" },
    });

    if (!rate) {
      throw new AppError(
        "NO_EXCHANGE_RATE",
        "No exchange rate configured",
        500
      );
    }

    return rate;
  }

  // ─────────────────────────────────────
  // PRIVATE: AML / Compliance checks
  // ─────────────────────────────────────
  private async runAmlChecks(
    userId: string,
    creatorProfileId: string,
    amount: bigint
  ): Promise<void> {
    // Check 1: Large single withdrawal
    if (amount >= WITHDRAWAL_CONFIG.AML_THRESHOLD_STARS) {
      await prisma.complianceFlag.create({
        data: {
          userId,
          flagType: "LARGE_WITHDRAWAL",
          severity: "MEDIUM",
          description: `Large withdrawal requested: ${amount} stars`,
          metadata: { amount: amount.toString(), profileId: creatorProfileId },
        },
      });
    }

    // Check 2: Multiple withdrawals in short period
    const recentPayouts = await prisma.creatorPayout.count({
      where: {
        creatorId: creatorProfileId,
        requestedAt: {
          gte: new Date(Date.now() - 24 * 60 * 60 * 1000),
        },
        status: {
          notIn: [PayoutStatus.CANCELLED, PayoutStatus.FAILED],
        },
      },
    });

    if (recentPayouts >= 5) {
      await prisma.complianceFlag.create({
        data: {
          userId,
          flagType: "HIGH_FREQUENCY_WITHDRAWAL",
          severity: "HIGH",
          description: `${recentPayouts} withdrawals in 24 hours`,
          metadata: { count: recentPayouts, profileId: creatorProfileId },
        },
      });

      throw new AppError(
        "AML_HOLD",
        "Your account has been temporarily flagged for review. Please contact support.",
        403
      );
    }

    // Check 3: Existing unresolved critical flags
    const criticalFlags = await prisma.complianceFlag.count({
      where: {
        userId,
        severity: "CRITICAL",
        isResolved: false,
      },
    });

    if (criticalFlags > 0) {
      throw new AppError(
        "ACCOUNT_RESTRICTED",
        "Your account has restrictions. Please contact support.",
        403
      );
    }
  }
}
export const withdrawalService = new WithdrawalService();
