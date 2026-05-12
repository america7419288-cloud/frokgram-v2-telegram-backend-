import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { paidReactionService } from "../services/stars/PaidReactionService";
import { messageTipService } from "../services/stars/MessageTipService";
import { revenueSettlementService } from "../services/stars/RevenueSettlementService";
import { authMiddleware } from "../middleware/authMiddleware";
import { validateRequest } from "../middleware/validateRequest";

const router = Router();
router.use(authMiddleware);

// ── Schemas ───────────────────────────────
const SendReactionSchema = z.object({
  body: z.object({
    chatId: z.string().min(1),
    messageId: z.string().min(1),
    emoji: z.string().min(1).max(10),
    starsAmount: z.number().int().positive().min(1).max(2500),
    ownerUserId: z.string().min(1),
    isAnonymous: z.boolean().default(false),
  }),
});

const SendTipSchema = z.object({
  body: z.object({
    toUserId: z.string().min(1),
    starsAmount: z.number().int().positive().min(1).max(10000),
    messageId: z.string().optional(),
    chatId: z.string().optional(),
    message: z.string().max(200).optional(),
    isAnonymous: z.boolean().default(false),
  }),
});

// ─────────────────────────────────────────
// POST /api/v1/reactions/paid
// Send a paid reaction
// ─────────────────────────────────────────
router.post(
  "/paid",
  validateRequest(SendReactionSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const {
        chatId, messageId, emoji,
        starsAmount, ownerUserId, isAnonymous,
      } = req.body;

      const result = await paidReactionService.sendPaidReaction(
        req.user!.id,
        chatId,
        messageId,
        emoji,
        BigInt(starsAmount),
        ownerUserId,
        { isAnonymous }
      );

      res.status(201).json({
        success: true,
        message: `Reacted with ${emoji} and ${starsAmount} stars!`,
        data: {
          reactionId: result.reactionId,
          starsSpent: result.starsSpent.toString(),
          ownerEarned: result.ownerEarned.toString(),
          leaderboardPosition: result.newLeaderboardPosition,
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

// ─────────────────────────────────────────
// GET /api/v1/reactions/leaderboard/:entityType/:entityId
// entityType = "message" | "chat"
// ─────────────────────────────────────────
router.get(
  "/leaderboard/:entityType/:entityId",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { entityType, entityId } = req.params;
      if (entityType !== "message" && entityType !== "chat") {
        return res.status(400).json({
          success: false,
          error: { code: "INVALID_ENTITY_TYPE", message: "Must be message or chat" },
        });
      }

      const leaderboard = await paidReactionService.getLeaderboard(
        entityId,
        entityType,
        Number(req.query.limit) || 10
      );

      res.json({ success: true, data: { leaderboard } });
    } catch (err) {
      next(err);
    }
  }
);

// ─────────────────────────────────────────
// GET /api/v1/reactions/message/:messageId/total
// ─────────────────────────────────────────
router.get(
  "/message/:messageId/total",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const totals = await paidReactionService.getMessageTotalStars(
        req.params.messageId
      );
      res.json({
        success: true,
        data: {
          ...totals,
          totalStars: totals.totalStars.toString(),
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

// ─────────────────────────────────────────
// GET /api/v1/reactions/chat/:chatId/top
// ─────────────────────────────────────────
router.get(
  "/chat/:chatId/top",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const period = (req.query.period as any) || "week";
      const topReactors = await paidReactionService.getTopReactors(
        req.params.chatId,
        period,
        Number(req.query.limit) || 10
      );
      res.json({ success: true, data: { topReactors, period } });
    } catch (err) {
      next(err);
    }
  }
);

// ─────────────────────────────────────────
// POST /api/v1/reactions/tip
// Tip a creator or message
// ─────────────────────────────────────────
router.post(
  "/tip",
  validateRequest(SendTipSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await messageTipService.tipMessage(
        req.user!.id,
        req.body.toUserId,
        BigInt(req.body.starsAmount),
        {
          messageId: req.body.messageId,
          chatId: req.body.chatId,
          tipMessage: req.body.message,
          isAnonymous: req.body.isAnonymous,
        }
      );

      res.status(201).json({
        success: true,
        message: `Tipped ${req.body.starsAmount} stars!`,
        data: {
          tipId: result.tipId,
          starsSpent: result.starsSpent.toString(),
          creatorEarned: result.creatorEarned.toString(),
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

// ─────────────────────────────────────────
// GET /api/v1/reactions/tip/message/:messageId
// Get earnings for a specific message
// ─────────────────────────────────────────
router.get(
  "/tip/message/:messageId",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const earnings = await messageTipService.getMessageEarnings(
        req.params.messageId
      );
      res.json({
        success: true,
        data: {
          ...earnings,
          totalTips: earnings.totalTips.toString(),
          totalStars: earnings.totalStars.toString(),
          topTip: earnings.topTip.toString(),
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

// ─────────────────────────────────────────
// GET /api/v1/reactions/revenue/pending
// Creator's pending settlement balance
// ─────────────────────────────────────────
router.get(
  "/revenue/pending",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const pending = await revenueSettlementService.getPendingBalance(
        req.user!.id
      );
      res.json({
        success: true,
        data: {
          ...pending,
          pendingAmount: pending.pendingAmount.toString(),
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

// ─────────────────────────────────────────
// GET /api/v1/reactions/revenue/history
// ─────────────────────────────────────────
router.get(
  "/revenue/history",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const history = await revenueSettlementService.getSettlementHistory(
        req.user!.id,
        {
          page: Number(req.query.page) || 1,
          limit: Number(req.query.limit) || 20,
        }
      );
      res.json({ success: true, data: history });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
