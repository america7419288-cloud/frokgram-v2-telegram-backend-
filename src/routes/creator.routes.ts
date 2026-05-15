import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { creatorProfileService } from "../services/creator/CreatorProfileService";
import { payoutMethodService } from "../services/creator/PayoutMethodService";
import { withdrawalService } from "../services/creator/WithdrawalService";
import { taxInfoService } from "../services/creator/TaxInfoService";
import { authMiddleware } from "../middleware/authMiddleware";
import { validateRequest } from "../middleware/validateRequest";
import { AppError } from "../lib/errors";

const router = Router();
router.use(authMiddleware);

// ── Schemas ───────────────────────────────
const UpdateProfileSchema = z.object({
  body: z.object({
    displayName: z.string().min(1).max(100).optional(),
    bio: z.string().max(500).optional(),
    category: z.string().optional(),
  }),
});

const AddPayoutMethodSchema = z.object({
  body: z.object({
    type: z.enum([
      "TON_WALLET",
      "BANK_TRANSFER",
      "PAYPAL",
      "STRIPE",
      "USDT_TRC20",
      "USDT_ERC20",
    ]),
    isDefault: z.boolean().optional(),
    tonAddress: z.string().optional(),
    bankAccountName: z.string().optional(),
    bankAccountNum: z.string().optional(),
    bankRoutingNum: z.string().optional(),
    bankName: z.string().optional(),
    bankCountry: z.string().optional(),
    paypalEmail: z.string().email().optional(),
  }),
});

const WithdrawalSchema = z.object({
  body: z.object({
    starsAmount: z.number().int().positive(),
    payoutMethodId: z.string().uuid(),
  }),
});

const TaxInfoSchema = z.object({
  body: z.object({
    taxFormType: z.enum(["W9", "W8BEN", "W8BEN-E"]),
    fullLegalName: z.string().min(2).max(200),
    address: z.string().min(5).max(500),
    country: z.string().length(2), // ISO country code
    taxId: z.string().optional(),
  }),
});

const RevenueChartSchema = z.object({
  query: z.object({
    period: z.enum(["7d", "30d", "90d", "1y"]).default("30d"),
    granularity: z.enum(["day", "week", "month"]).default("day"),
  }),
});

// ─────────────────────────────────────────
// GET /api/v1/creator/profile
// ─────────────────────────────────────────
router.get(
  "/profile",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const profile = await creatorProfileService.getOrCreateProfile(
        req.user!.id
      );
      res.json({
        success: true,
        data: {
          ...profile,
          totalEarned: profile.totalEarned.toString(),
          totalWithdrawn: profile.totalWithdrawn.toString(),
          pendingBalance: profile.pendingBalance.toString(),
          availableBalance: profile.availableBalance.toString(),
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

// ─────────────────────────────────────────
// PUT /api/v1/creator/profile
// ─────────────────────────────────────────
router.put(
  "/profile",
  validateRequest(UpdateProfileSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await creatorProfileService.updateProfile(req.user!.id, req.body);
      res.json({ success: true, message: "Profile updated" });
    } catch (err) {
      next(err);
    }
  }
);

// ─────────────────────────────────────────
// POST /api/v1/creator/monetization/enable
// ─────────────────────────────────────────
router.post(
  "/monetization/enable",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await creatorProfileService.enableMonetization(req.user!.id);
      res.json({
        success: true,
        message: "Monetization enabled! You can now earn stars.",
      });
    } catch (err) {
      next(err);
    }
  }
);

// ─────────────────────────────────────────
// GET /api/v1/creator/dashboard
// ─────────────────────────────────────────
router.get(
  "/dashboard",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const stats = await creatorProfileService.getDashboardStats(
        req.user!.id
      );
      res.json({
        success: true,
        data: {
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
            Object.entries(stats.earningsBySource).map(([k, v]) => [
              k,
              v.toString(),
            ])
          ),
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

// ─────────────────────────────────────────
// GET /api/v1/creator/earnings
// ─────────────────────────────────────────
router.get(
  "/earnings",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await creatorProfileService.getEarningsHistory(
        req.user!.id,
        {
          page: Number(req.query.page) || 1,
          limit: Number(req.query.limit) || 20,
          sourceType: req.query.sourceType as string | undefined,
          period: req.query.period as string | undefined,
        }
      );
      res.json({ success: true, data: result });
    } catch (err) {
      next(err);
    }
  }
);

// ─────────────────────────────────────────
// GET /api/v1/creator/earnings/chart
// ─────────────────────────────────────────
router.get(
  "/earnings/chart",
  validateRequest(RevenueChartSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = await creatorProfileService.getRevenueChart(
        req.user!.id,
        (req.query.period as any) || "30d",
        (req.query.granularity as any) || "day"
      );
      res.json({ success: true, data: { chart: data } });
    } catch (err) {
      next(err);
    }
  }
);

// ─────────────────────────────────────────
// GET /api/v1/creator/earnings/top-content
// ─────────────────────────────────────────
router.get(
  "/earnings/top-content",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const sourceType = (req.query.sourceType as string) || "PAID_REACTION";
      const topContent = await creatorProfileService.getTopContent(
        req.user!.id,
        sourceType,
        Number(req.query.limit) || 10
      );
      res.json({ success: true, data: { topContent } });
    } catch (err) {
      next(err);
    }
  }
);

// ─────────────────────────────────────────
// GET /api/v1/creator/payout-methods
// ─────────────────────────────────────────
router.get(
  "/payout-methods",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const methods = await payoutMethodService.getPayoutMethods(
        req.user!.id
      );
      res.json({ success: true, data: { methods } });
    } catch (err) {
      next(err);
    }
  }
);

// ─────────────────────────────────────────
// POST /api/v1/creator/payout-methods
// ─────────────────────────────────────────
router.post(
  "/payout-methods",
  validateRequest(AddPayoutMethodSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const methodId = await payoutMethodService.addPayoutMethod(
        req.user!.id,
        req.body
      );
      res.status(201).json({
        success: true,
        message: "Payout method added successfully",
        data: { methodId },
      });
    } catch (err) {
      next(err);
    }
  }
);

// ─────────────────────────────────────────
// PUT /api/v1/creator/payout-methods/:id/default
// ─────────────────────────────────────────
router.put(
  "/payout-methods/:id/default",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await payoutMethodService.setDefault(req.user!.id, req.params.id);
      res.json({ success: true, message: "Default payout method updated" });
    } catch (err) {
      next(err);
    }
  }
);

// ─────────────────────────────────────────
// DELETE /api/v1/creator/payout-methods/:id
// ─────────────────────────────────────────
router.delete(
  "/payout-methods/:id",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await payoutMethodService.removeMethod(req.user!.id, req.params.id);
      res.json({ success: true, message: "Payout method removed" });
    } catch (err) {
      next(err);
    }
  }
);

// ─────────────────────────────────────────
// POST /api/v1/creator/withdrawal/request
// ─────────────────────────────────────────
router.post(
  "/withdrawal/request",
  validateRequest(WithdrawalSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await withdrawalService.requestWithdrawal(
        req.user!.id,
        BigInt(req.body.starsAmount),
        req.body.payoutMethodId
      );

      res.status(201).json({
        success: true,
        message: "Withdrawal request submitted successfully",
        data: {
          payoutId: result.payoutId,
          starsAmount: result.starsAmount.toString(),
          platformFee: result.platformFee.toString(),
          netStars: result.netStars.toString(),
          estimatedFiatAmount: result.estimatedFiatAmount.toFixed(2),
          estimatedCompletionDate: result.estimatedCompletionDate,
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

// ─────────────────────────────────────────
// POST /api/v1/creator/withdrawal/:id/cancel
// ─────────────────────────────────────────
router.post(
  "/withdrawal/:id/cancel",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await withdrawalService.cancelWithdrawal(
        req.user!.id,
        req.params.id
      );
      res.json({
        success: true,
        message: "Withdrawal cancelled. Stars returned to your available balance.",
      });
    } catch (err) {
      next(err);
    }
  }
);

// ─────────────────────────────────────────
// GET /api/v1/creator/withdrawal/history
// ─────────────────────────────────────────
router.get(
  "/withdrawal/history",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await withdrawalService.getPayoutHistory(
        req.user!.id,
        {
          page: Number(req.query.page) || 1,
          limit: Number(req.query.limit) || 20,
          status: req.query.status as any,
        }
      );
      res.json({ success: true, data: result });
    } catch (err) {
      next(err);
    }
  }
);

// ─────────────────────────────────────────
// GET /api/v1/creator/withdrawal/:id/status
// ─────────────────────────────────────────
router.get(
  "/withdrawal/:id/status",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const status = await withdrawalService.getPayoutStatus(
        req.user!.id,
        req.params.id
      );
      res.json({ success: true, data: status });
    } catch (err) {
      next(err);
    }
  }
);

// ─────────────────────────────────────────
// GET /api/v1/creator/tax/status
// ─────────────────────────────────────────
router.get(
  "/tax/status",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const status = await taxInfoService.getTaxInfoStatus(req.user!.id);
      res.json({ success: true, data: status });
    } catch (err) {
      next(err);
    }
  }
);

// ─────────────────────────────────────────
// POST /api/v1/creator/tax/submit
// ─────────────────────────────────────────
router.post(
  "/tax/submit",
  validateRequest(TaxInfoSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await taxInfoService.submitTaxInfo(req.user!.id, req.body);
      res.json({
        success: true,
        message: "Tax information submitted for review",
      });
    } catch (err) {
      next(err);
    }
  }
);

// ─────────────────────────────────────────
// GET /api/v1/creator/tax/annual-report/:year
// ─────────────────────────────────────────
router.get(
  "/tax/annual-report/:year",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const year = parseInt(req.params.year);
      if (isNaN(year) || year < 2020 || year > new Date().getFullYear()) {
        throw new AppError("INVALID_YEAR", "Invalid year", 400);
      }
      const report = await taxInfoService.generateAnnualReport(
        req.user!.id,
        year
      );
      res.json({
        success: true,
        data: {
          ...report,
          totalEarned: report.totalEarned.toString(),
          totalWithdrawn: report.totalWithdrawn.toString(),
          platformFeesPaid: report.platformFeesPaid.toString(),
          earningsBySource: Object.fromEntries(
            Object.entries(report.earningsBySource).map(([k, v]) => [
              k,
              v.toString(),
            ])
          ),
          monthlyBreakdown: report.monthlyBreakdown.map((m) => ({
            ...m,
            earned: m.earned.toString(),
          })),
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
