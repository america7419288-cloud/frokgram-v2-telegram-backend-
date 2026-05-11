import {
  PurchaseOrderStatus,
  StarsTransactionType,
} from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { starsWalletService } from "./StarsWalletService";
import { iapService } from "../premium/IAPVerificationService";
import { AppError } from "../../lib/errors";
import { EventBus } from "../../lib/eventBus";

// ─────────────────────────────────────────
// Anti-Fraud Config
// ─────────────────────────────────────────
const FRAUD_CONFIG = {
  MAX_PURCHASES_PER_DAY: 10,
  MAX_STARS_PER_DAY: BigInt(50000),
  SUSPICIOUS_THRESHOLD: BigInt(10000), // flag purchases over this
};

// ─────────────────────────────────────────
// Stars Purchase Service
// Handles buying stars with real money
// ─────────────────────────────────────────
export class StarsPurchaseService {

  // ─────────────────────────────────────
  // INITIATE PURCHASE
  // Step 1: Create order before payment
  // ─────────────────────────────────────
  async initiatePurchase(
    userId: string,
    tierId: string,
    paymentProvider: string
  ): Promise<{
    orderId: string;
    starsAmount: bigint;
    bonusStars: bigint;
    totalStars: bigint;
    fiatAmount: number;
    currency: string;
  }> {
    // 1. Get tier
    const tier = await prisma.starsPriceTier.findUnique({
      where: { id: tierId },
    });

    if (!tier || !tier.isActive) {
      throw new AppError("TIER_NOT_FOUND", "Price tier not found", 404);
    }

    // 2. Fraud checks
    await this.checkFraudLimits(userId, tier.starsCount);

    // 3. Create pending order
    const order = await prisma.starsPurchaseOrder.create({
      data: {
        userId,
        starsAmount: tier.starsCount,
        fiatAmount: tier.priceUsd,
        currency: "USD",
        paymentProvider,
        status: PurchaseOrderStatus.PENDING,
        tierId,
        bonusStars: tier.bonusStars,
      },
    });

    return {
      orderId: order.id,
      starsAmount: tier.starsCount,
      bonusStars: tier.bonusStars,
      totalStars: tier.starsCount + tier.bonusStars,
      fiatAmount: Number(tier.priceUsd),
      currency: "USD",
    };
  }

  // ─────────────────────────────────────
  // COMPLETE PURCHASE (after payment confirmed)
  // Step 2: Verify payment → credit stars
  // ─────────────────────────────────────
  async completePurchase(
    userId: string,
    orderId: string,
    paymentProof: {
      provider: "apple_iap" | "google_play" | "ton" | "stripe";
      receiptData?: string;
      providerTxId?: string;
      productId?: string;
      packageName?: string;
    }
  ): Promise<{
    transactionId: string;
    starsAwarded: bigint;
    newBalance: bigint;
  }> {
    // 1. Get order
    const order = await prisma.starsPurchaseOrder.findFirst({
      where: { id: orderId, userId, status: PurchaseOrderStatus.PENDING },
    });

    if (!order) {
      throw new AppError("ORDER_NOT_FOUND", "Purchase order not found or already processed", 404);
    }

    // 2. Fraud checks (Double check at completion to prevent race conditions)
    await this.checkFraudLimits(userId, order.starsAmount);

    // 3. Verify payment based on provider
    let providerTxId: string;

    try {
      switch (paymentProof.provider) {
        case "apple_iap": {
          if (!paymentProof.receiptData) {
            throw new AppError("MISSING_RECEIPT", "Apple receipt data required", 400);
          }
          const appleResult = await iapService.verifyAppleReceipt(
            paymentProof.receiptData
          );
          if (!appleResult.isValid) {
            throw new AppError("INVALID_RECEIPT", "Apple receipt verification failed", 400);
          }

          // Check for duplicate receipt
          await this.checkDuplicateProviderTx(appleResult.transactionId);
          providerTxId = appleResult.transactionId;
          break;
        }

        case "google_play": {
          if (!paymentProof.receiptData || !paymentProof.productId || !paymentProof.packageName) {
            throw new AppError("MISSING_PARAMS", "Google Play params required", 400);
          }
          const googleResult = await iapService.verifyGooglePlayPurchase(
            paymentProof.receiptData,
            paymentProof.productId,
            paymentProof.packageName
          );
          if (!googleResult.isValid) {
            throw new AppError("INVALID_RECEIPT", "Google Play verification failed", 400);
          }

          await this.checkDuplicateProviderTx(googleResult.orderId);
          providerTxId = googleResult.orderId;
          break;
        }

        case "ton":
        case "stripe": {
          // For TON and Stripe, providerTxId is passed directly
          if (!paymentProof.providerTxId) {
            throw new AppError("MISSING_TX_ID", "Provider transaction ID required", 400);
          }
          await this.checkDuplicateProviderTx(paymentProof.providerTxId);
          providerTxId = paymentProof.providerTxId;
          break;
        }

        default:
          throw new AppError("UNSUPPORTED_PROVIDER", "Unsupported payment provider", 400);
      }
    } catch (err) {
      // Mark order as failed
      await prisma.starsPurchaseOrder.update({
        where: { id: orderId },
        data: {
          status: PurchaseOrderStatus.FAILED,
          failureReason: (err as Error).message,
        },
      });
      throw err;
    }

    // 3. Mark order processing
    await prisma.starsPurchaseOrder.update({
      where: { id: orderId },
      data: {
        status: PurchaseOrderStatus.PROCESSING,
        providerOrderId: providerTxId,
        receiptData: paymentProof.receiptData ?? null,
      },
    });

    // 4. Credit stars to wallet
    const totalStars = order.starsAmount + order.bonusStars;

    const creditResult = await starsWalletService.creditStars(
      userId,
      totalStars,
      StarsTransactionType.PURCHASE,
      {
        referenceId: orderId,
        referenceType: "purchase_order",
        description: `Purchased ${order.starsAmount} stars${order.bonusStars > 0 ? ` + ${order.bonusStars} bonus` : ""}`,
        metadata: {
          orderId,
          providerTxId,
          provider: paymentProof.provider,
          baseStars: order.starsAmount.toString(),
          bonusStars: order.bonusStars.toString(),
        },
      }
    );

    // 5. Mark order complete and link transaction ID
    await prisma.starsPurchaseOrder.update({
      where: { id: orderId },
      data: {
        status: PurchaseOrderStatus.COMPLETED,
        completedAt: new Date(),
        metadata: {
          ...(order.metadata as object || {}),
          transactionId: creditResult.transactionId,
        }
      },
    });

    await EventBus.emit("stars.purchased", {
      userId,
      starsAmount: totalStars.toString(),
      orderId,
      provider: paymentProof.provider,
    });

    return {
      transactionId: creditResult.transactionId,
      starsAwarded: totalStars,
      newBalance: creditResult.newBalance,
    };
  }

  // ─────────────────────────────────────
  // REFUND PURCHASE
  // ─────────────────────────────────────
  async refundPurchase(
    userId: string,
    orderId: string,
    adminId: string,
    reason: string
  ): Promise<void> {
    const order = await prisma.starsPurchaseOrder.findFirst({
      where: { id: orderId, userId, status: PurchaseOrderStatus.COMPLETED },
    });

    if (!order) {
      throw new AppError("ORDER_NOT_FOUND", "Completed order not found", 404);
    }

    const totalStars = order.starsAmount + order.bonusStars;

    // Check user still has enough to refund
    const balance = await starsWalletService.getBalance(userId);
    if (balance.available < totalStars) {
      throw new AppError(
        "INSUFFICIENT_BALANCE_FOR_REFUND",
        "User has spent stars — partial refund may be needed",
        409,
        { available: balance.available.toString(), refundAmount: totalStars.toString() }
      );
    }

    // Debit the stars back
    await starsWalletService.debitStars(
      userId,
      totalStars,
      StarsTransactionType.REFUND,
      {
        referenceId: orderId,
        referenceType: "purchase_order",
        description: `Refund for order ${orderId}: ${reason}`,
        metadata: { adminId, reason },
        skipBalanceCheck: false,
      }
    );

    // Update order status
    await prisma.starsPurchaseOrder.update({
      where: { id: orderId },
      data: { status: PurchaseOrderStatus.REFUNDED },
    });

    await EventBus.emit("stars.refunded", {
      userId,
      orderId,
      starsRefunded: totalStars.toString(),
      adminId,
    });
  }

  // ─────────────────────────────────────
  // PRIVATE: Fraud limit check
  // ─────────────────────────────────────
  private async checkFraudLimits(
    userId: string,
    purchaseAmount: bigint
  ): Promise<void> {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const todayOrders = await prisma.starsPurchaseOrder.findMany({
      where: {
        userId,
        createdAt: { gte: today },
        status: {
          in: [
            PurchaseOrderStatus.COMPLETED,
            PurchaseOrderStatus.PENDING,
            PurchaseOrderStatus.PROCESSING,
          ],
        },
      },
    });

    // Check purchase count limit
    if (todayOrders.length >= FRAUD_CONFIG.MAX_PURCHASES_PER_DAY) {
      throw new AppError(
        "DAILY_PURCHASE_LIMIT",
        "Daily purchase limit reached. Please try again tomorrow.",
        429
      );
    }

    // Check daily stars limit
    const todayTotal = todayOrders.reduce(
      (sum, o) => sum + o.starsAmount,
      BigInt(0)
    );

    if (todayTotal + purchaseAmount > FRAUD_CONFIG.MAX_STARS_PER_DAY) {
      throw new AppError(
        "DAILY_STARS_LIMIT",
        "Daily stars purchase limit reached",
        429,
        { dailyLimit: FRAUD_CONFIG.MAX_STARS_PER_DAY.toString() }
      );
    }

    // Flag large purchases for review
    if (purchaseAmount >= FRAUD_CONFIG.SUSPICIOUS_THRESHOLD) {
      await EventBus.emit("stars.large_purchase_flagged", {
        userId,
        amount: purchaseAmount.toString(),
      });
    }
  }

  // ─────────────────────────────────────
  // PRIVATE: Check duplicate provider tx
  // ─────────────────────────────────────
  private async checkDuplicateProviderTx(providerTxId: string): Promise<void> {
    const existing = await prisma.starsPurchaseOrder.findFirst({
      where: {
        providerOrderId: providerTxId,
        status: {
          in: [PurchaseOrderStatus.COMPLETED, PurchaseOrderStatus.PROCESSING],
        },
      },
    });

    if (existing) {
      throw new AppError(
        "DUPLICATE_TRANSACTION",
        "This payment has already been processed",
        409
      );
    }
  }
}

export const starsPurchaseService = new StarsPurchaseService();
