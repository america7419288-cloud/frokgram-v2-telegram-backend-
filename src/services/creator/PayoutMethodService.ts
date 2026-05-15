import { PayoutMethodType } from "@prisma/client";
import { AppError } from "../../lib/errors";
import { prisma } from "../../lib/prisma";

// ─────────────────────────────────────────
// Types
// ─────────────────────────────────────────
export interface AddPayoutMethodOptions {
  type: PayoutMethodType;
  isDefault?: boolean;

  // TON
  tonAddress?: string;

  // Bank
  bankAccountName?: string;
  bankAccountNum?: string;
  bankRoutingNum?: string;
  bankName?: string;
  bankCountry?: string;

  // PayPal
  paypalEmail?: string;
}

// ─────────────────────────────────────────
// Payout Method Service
// ─────────────────────────────────────────
export class PayoutMethodService {

  // ─────────────────────────────────────
  // ADD PAYOUT METHOD
  // ─────────────────────────────────────
  async addPayoutMethod(
    userId: string,
    options: AddPayoutMethodOptions
  ): Promise<string> {
    // Validate method-specific fields
    this.validateMethodFields(options);

    const profile = await prisma.creatorProfile.findUnique({
      where: { userId },
    });
    if (!profile) {
      throw new AppError(
        "PROFILE_NOT_FOUND",
        "Creator profile not found. Please set up your profile first.",
        404
      );
    }

    // Check existing method count
    const existingCount = await prisma.creatorPayoutMethod.count({
      where: { creatorId: profile.id },
    });
    if (existingCount >= 5) {
      throw new AppError(
        "MAX_METHODS_REACHED",
        "Maximum 5 payout methods allowed",
        400
      );
    }

    // Check for duplicate
    await this.checkDuplicateMethod(profile.id, options);

    const method = await prisma.$transaction(async (tx) => {
      // If setting as default, unset other defaults
      if (options.isDefault) {
        await tx.creatorPayoutMethod.updateMany({
          where: { creatorId: profile.id, isDefault: true },
          data: { isDefault: false },
        });
      }

      return tx.creatorPayoutMethod.create({
        data: {
          creatorId: profile.id,
          type: options.type,
          isDefault: options.isDefault ?? existingCount === 0, // first method is default
          isVerified: false,
          tonAddress: options.tonAddress ?? null,
          bankAccountName: options.bankAccountName ?? null,
          bankAccountNum: options.bankAccountNum
            ? `****${options.bankAccountNum.slice(-4)}`
            : null,
          bankRoutingNum: options.bankRoutingNum ?? null,
          bankName: options.bankName ?? null,
          bankCountry: options.bankCountry ?? null,
          paypalEmail: options.paypalEmail ?? null,
          minPayoutStars: BigInt(1000),
        },
      });
    });

    return method.id;
  }

  // ─────────────────────────────────────
  // SET DEFAULT PAYOUT METHOD
  // ─────────────────────────────────────
  async setDefault(userId: string, methodId: string): Promise<void> {
    const profile = await prisma.creatorProfile.findUnique({
      where: { userId },
    });
    if (!profile) throw new AppError("PROFILE_NOT_FOUND", "Profile not found", 404);

    const method = await prisma.creatorPayoutMethod.findFirst({
      where: { id: methodId, creatorId: profile.id },
    });
    if (!method) {
      throw new AppError("METHOD_NOT_FOUND", "Payout method not found", 404);
    }

    await prisma.$transaction([
      prisma.creatorPayoutMethod.updateMany({
        where: { creatorId: profile.id },
        data: { isDefault: false },
      }),
      prisma.creatorPayoutMethod.update({
        where: { id: methodId },
        data: { isDefault: true },
      }),
    ]);
  }

  // ─────────────────────────────────────
  // REMOVE PAYOUT METHOD
  // ─────────────────────────────────────
  async removeMethod(userId: string, methodId: string): Promise<void> {
    const profile = await prisma.creatorProfile.findUnique({
      where: { userId },
    });
    if (!profile) throw new AppError("PROFILE_NOT_FOUND", "Profile not found", 404);

    const method = await prisma.creatorPayoutMethod.findFirst({
      where: { id: methodId, creatorId: profile.id },
    });
    if (!method) {
      throw new AppError("METHOD_NOT_FOUND", "Payout method not found", 404);
    }

    // Check no pending payouts using this method
    const pendingPayouts = await prisma.creatorPayout.count({
      where: {
        payoutMethodId: methodId,
        status: { in: ["PENDING", "APPROVED", "PROCESSING"] },
      },
    });
    if (pendingPayouts > 0) {
      throw new AppError(
        "METHOD_IN_USE",
        "Cannot remove method with pending payouts",
        409
      );
    }

    await prisma.creatorPayoutMethod.delete({ where: { id: methodId } });
  }

  // ─────────────────────────────────────
  // GET PAYOUT METHODS
  // ─────────────────────────────────────
  async getPayoutMethods(userId: string) {
    const profile = await prisma.creatorProfile.findUnique({
      where: { userId },
    });
    if (!profile) return [];

    return prisma.creatorPayoutMethod.findMany({
      where: { creatorId: profile.id },
      orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
    });
  }

  // ─────────────────────────────────────
  // PRIVATE: Validate method fields
  // ─────────────────────────────────────
  private validateMethodFields(options: AddPayoutMethodOptions): void {
    switch (options.type) {
      case PayoutMethodType.TON_WALLET:
        if (!options.tonAddress) {
          throw new AppError("MISSING_TON_ADDRESS", "TON wallet address required", 400);
        }
        if (!this.isValidTonAddress(options.tonAddress)) {
          throw new AppError("INVALID_TON_ADDRESS", "Invalid TON wallet address format", 400);
        }
        break;

      case PayoutMethodType.BANK_TRANSFER:
        if (!options.bankAccountName || !options.bankAccountNum) {
          throw new AppError(
            "MISSING_BANK_DETAILS",
            "Bank account name and number required",
            400
          );
        }
        break;

      case PayoutMethodType.PAYPAL:
        if (!options.paypalEmail) {
          throw new AppError("MISSING_PAYPAL_EMAIL", "PayPal email required", 400);
        }
        if (!this.isValidEmail(options.paypalEmail)) {
          throw new AppError("INVALID_EMAIL", "Invalid email format", 400);
        }
        break;

      default:
        throw new AppError("UNSUPPORTED_METHOD", "Unsupported payout method type", 400);
    }
  }

  // ─────────────────────────────────────
  // PRIVATE: Check for duplicate
  // ─────────────────────────────────────
  private async checkDuplicateMethod(
    creatorId: string,
    options: AddPayoutMethodOptions
  ): Promise<void> {
    let where: any = { creatorId, type: options.type };

    if (options.type === PayoutMethodType.TON_WALLET && options.tonAddress) {
      where.tonAddress = options.tonAddress;
    } else if (options.type === PayoutMethodType.PAYPAL && options.paypalEmail) {
      where.paypalEmail = options.paypalEmail;
    }

    const existing = await prisma.creatorPayoutMethod.findFirst({ where });
    if (existing) {
      throw new AppError(
        "DUPLICATE_METHOD",
        "This payout method is already registered",
        409
      );
    }
  }

  private isValidTonAddress(address: string): boolean {
    // TON addresses are 48 chars (user-friendly) or 64 chars (raw)
    return /^[0-9A-Za-z_-]{48}$/.test(address) ||
      /^[0-9A-Fa-f]{64}$/.test(address);
  }

  private isValidEmail(email: string): boolean {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  }
}

export const payoutMethodService = new PayoutMethodService();
