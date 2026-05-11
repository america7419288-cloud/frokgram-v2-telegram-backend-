import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { starsWalletService } from "../services/stars/StarsWalletService";
import { starsPurchaseService } from "../services/stars/StarsPurchaseService";
import { authMiddleware } from "../middleware/authMiddleware";
import { validateRequest } from "../middleware/validateRequest";
import { AppError } from "../lib/errors";

const router = Router();

router.use(authMiddleware);

// ─────────────────────────────────────────
// Validation Schemas
// ─────────────────────────────────────────
const InitiatePurchaseSchema = z.object({
  body: z.object({
    tierId: z.string().uuid("Invalid tier ID"),
    paymentProvider: z.enum(["apple_iap", "google_play", "ton", "stripe"]),
  }),
});

const CompletePurchaseSchema = z.object({
  body: z.object({
    orderId: z.string().uuid(),
    provider: z.enum(["apple_iap", "google_play", "ton", "stripe"]),
    receiptData: z.string().optional(),
    providerTxId: z.string().optional(),
    productId: z.string().optional(),
    packageName: z.string().optional(),
  }),
});

const TransferSchema = z.object({
  body: z.object({
    toUserId: z.string().min(1, "Recipient user ID required"),
    amount: z.number().int().positive().min(1).max(1000000),
    description: z.string().max(200).optional(),
  }),
});

const TransactionHistorySchema = z.object({
  query: z.object({
    page: z.string().regex(/^\d+$/).optional().transform(Number),
    limit: z.string().regex(/^\d+$/).optional().transform(Number),
    type: z.string().optional(),
    startDate: z.string().datetime().optional(),
    endDate: z.string().datetime().optional(),
  }),
});

// ─────────────────────────────────────────
// GET /api/v1/stars/balance
// Get current user's stars balance
// ─────────────────────────────────────────
router.get(
  "/balance",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const balance = await starsWalletService.getBalance(req.user!.id);

      res.json({
        success: true,
        data: {
          available: balance.available.toString(),
          locked: balance.locked.toString(),
          total: balance.total.toString(),
          lifetimeEarned: balance.lifetimeEarned.toString(),
          lifetimeSpent: balance.lifetimeSpent.toString(),
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

// ─────────────────────────────────────────
// GET /api/v1/stars/price-tiers
// Get available star packages to buy
// ─────────────────────────────────────────
router.get(
  "/price-tiers",
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const tiers = await starsWalletService.getPriceTiers();
      res.json({ success: true, data: { tiers } });
    } catch (err) {
      next(err);
    }
  }
);

// ─────────────────────────────────────────
// POST /api/v1/stars/purchase/initiate
// Step 1: Create purchase order
// ─────────────────────────────────────────
router.post(
  "/purchase/initiate",
  validateRequest(InitiatePurchaseSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await starsPurchaseService.initiatePurchase(
        req.user!.id,
        req.body.tierId,
        req.body.paymentProvider
      );

      res.status(201).json({
        success: true,
        message: "Purchase order created. Complete payment to receive stars.",
        data: {
          ...result,
          starsAmount: result.starsAmount.toString(),
          bonusStars: result.bonusStars.toString(),
          totalStars: result.totalStars.toString(),
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

// ─────────────────────────────────────────
// POST /api/v1/stars/purchase/complete
// Step 2: Submit payment proof → receive stars
// ─────────────────────────────────────────
router.post(
  "/purchase/complete",
  validateRequest(CompletePurchaseSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await starsPurchaseService.completePurchase(
        req.user!.id,
        req.body.orderId,
        {
          provider: req.body.provider,
          receiptData: req.body.receiptData,
          providerTxId: req.body.providerTxId,
          productId: req.body.productId,
          packageName: req.body.packageName,
        }
      );

      res.json({
        success: true,
        message: `${result.starsAwarded} stars added to your wallet!`,
        data: {
          transactionId: result.transactionId,
          starsAwarded: result.starsAwarded.toString(),
          newBalance: result.newBalance.toString(),
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

// ─────────────────────────────────────────
// POST /api/v1/stars/transfer
// Transfer stars to another user
// ─────────────────────────────────────────
router.post(
  "/transfer",
  validateRequest(TransferSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { toUserId, amount, description } = req.body;

      const result = await starsWalletService.transferStars(
        req.user!.id,
        toUserId,
        BigInt(amount),
        { description }
      );

      res.json({
        success: true,
        message: `${amount} stars transferred successfully`,
        data: {
          transactionId: result.transactionId,
          amount: result.amount.toString(),
          fromBalance: result.fromBalance.toString(),
          completedAt: result.completedAt,
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

// ─────────────────────────────────────────
// GET /api/v1/stars/transactions
// Get transaction history
// ─────────────────────────────────────────
router.get(
  "/transactions",
  validateRequest(TransactionHistorySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { page, limit, type, startDate, endDate } = req.query as any;

      const result = await starsWalletService.getTransactionHistory(
        req.user!.id,
        {
          page: page ? Number(page) : 1,
          limit: limit ? Number(limit) : 20,
          type: type as any,
          startDate: startDate ? new Date(startDate) : undefined,
          endDate: endDate ? new Date(endDate) : undefined,
        }
      );

      res.json({
        success: true,
        data: {
          transactions: result.transactions.map((t) => ({
            ...t,
            amount: t.amount.toString(),
          })),
          pagination: result.pagination,
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
