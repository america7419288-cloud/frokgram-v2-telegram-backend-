import { AppError } from "../../lib/errors";
import { prisma } from "../../lib/prisma";

// ─────────────────────────────────────────
// Tax Info Service
// ─────────────────────────────────────────
export class TaxInfoService {

  // ─────────────────────────────────────
  // SUBMIT TAX INFO
  // ─────────────────────────────────────
  async submitTaxInfo(
    userId: string,
    data: {
      taxFormType: string;
      fullLegalName: string;
      address: string;
      country: string;
      taxId?: string;
    }
  ): Promise<void> {
    const profile = await prisma.creatorProfile.findUnique({
      where: { userId },
    });
    if (!profile) {
      throw new AppError("PROFILE_NOT_FOUND", "Creator profile not found", 404);
    }

    // Validate tax form type
    const validForms = ["W9", "W8BEN", "W8BEN-E"];
    if (!validForms.includes(data.taxFormType)) {
      throw new AppError(
        "INVALID_TAX_FORM",
        `Tax form must be one of: ${validForms.join(", ")}`,
        400
      );
    }

    // US residents need W9 with SSN/EIN
    if (data.country === "US" && data.taxFormType !== "W9") {
      throw new AppError(
        "WRONG_TAX_FORM",
        "US residents must submit W9",
        400
      );
    }

    await prisma.creatorTaxInfo.upsert({
      where: { creatorId: profile.id },
      update: {
        taxFormType: data.taxFormType,
        fullLegalName: data.fullLegalName,
        address: data.address,
        country: data.country,
        taxId: data.taxId
          ? `***-**-${data.taxId.slice(-4)}`
          : undefined, // mask the tax ID
        isSubmitted: true,
        submittedAt: new Date(),
        isVerified: false,  // needs admin review
      },
      create: {
        creatorId: profile.id,
        taxFormType: data.taxFormType,
        fullLegalName: data.fullLegalName,
        address: data.address,
        country: data.country,
        taxId: data.taxId
          ? `***-**-${data.taxId.slice(-4)}`
          : null,
        isSubmitted: true,
        submittedAt: new Date(),
      },
    });
  }

  // ─────────────────────────────────────
  // GET TAX INFO STATUS
  // ─────────────────────────────────────
  async getTaxInfoStatus(userId: string) {
    const profile = await prisma.creatorProfile.findUnique({
      where: { userId },
      include: { taxInfo: true },
    });

    if (!profile?.taxInfo) {
      return {
        isSubmitted: false,
        isVerified: false,
        requiresAction: true,
        message: "Tax information required for payouts over $600/year",
      };
    }

    return {
      isSubmitted: profile.taxInfo.isSubmitted,
      isVerified: profile.taxInfo.isVerified,
      taxFormType: profile.taxInfo.taxFormType,
      country: profile.taxInfo.country,
      submittedAt: profile.taxInfo.submittedAt,
      requiresAction: !profile.taxInfo.isVerified,
    };
  }

  // ─────────────────────────────────────
  // GENERATE ANNUAL EARNINGS REPORT
  // ─────────────────────────────────────
  async generateAnnualReport(
    userId: string,
    year: number
  ): Promise<{
    year: number;
    totalEarned: bigint;
    totalWithdrawn: bigint;
    platformFeesPaid: bigint;
    earningsBySource: Record<string, bigint>;
    monthlyBreakdown: Array<{
      month: string;
      earned: bigint;
    }>;
  }> {
    const profile = await prisma.creatorProfile.findUnique({
      where: { userId },
    });
    if (!profile) {
      throw new AppError("PROFILE_NOT_FOUND", "Profile not found", 404);
    }

    const yearStart = new Date(year, 0, 1);
    const yearEnd = new Date(year, 11, 31, 23, 59, 59);

    const [aggregate, bySource, byMonth, withdrawals] = await Promise.all([
      prisma.creatorEarning.aggregate({
        where: {
          creatorId: profile.id,
          createdAt: { gte: yearStart, lte: yearEnd },
        },
        _sum: { netAmount: true, platformFee: true },
      }),

      prisma.creatorEarning.groupBy({
        by: ["sourceType"],
        where: {
          creatorId: profile.id,
          createdAt: { gte: yearStart, lte: yearEnd },
        },
        _sum: { netAmount: true },
      }),

      prisma.creatorEarning.groupBy({
        by: ["period"],
        where: {
          creatorId: profile.id,
          createdAt: { gte: yearStart, lte: yearEnd },
        },
        _sum: { netAmount: true },
        orderBy: { period: "asc" },
      }),

      prisma.creatorPayout.aggregate({
        where: {
          creatorId: profile.id,
          status: "COMPLETED",
          completedAt: { gte: yearStart, lte: yearEnd },
        },
        _sum: { netStars: true },
      }),
    ]);

    const earningsBySource: Record<string, bigint> = {};
    for (const group of bySource) {
      earningsBySource[group.sourceType] =
        group._sum.netAmount ?? BigInt(0);
    }

    return {
      year,
      totalEarned: aggregate._sum.netAmount ?? BigInt(0),
      totalWithdrawn: withdrawals._sum.netStars ?? BigInt(0),
      platformFeesPaid: aggregate._sum.platformFee ?? BigInt(0),
      earningsBySource,
      monthlyBreakdown: byMonth.map((m) => ({
        month: m.period,
        earned: m._sum.netAmount ?? BigInt(0),
      })),
    };
  }
}

export const taxInfoService = new TaxInfoService();
