import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { starsGiftService } from "../services/stars/StarsGiftService";
import { authMiddleware } from "../middleware/authMiddleware";
import { validateRequest } from "../middleware/validateRequest";

const router = Router();
router.use(authMiddleware);

// ── Schemas ───────────────────────────────
const SendGiftSchema = z.object({
  body: z.object({
    toUserId: z.string().min(1),
    starsAmount: z.number().int().positive().min(1),
    animationId: z.string().uuid().optional(),
    message: z.string().max(255).optional(),
  }),
});

const GetGiftsSchema = z.object({
  query: z.object({
    status: z.enum(["PENDING", "CLAIMED", "REJECTED", "EXPIRED"]).optional(),
    page: z.string().regex(/^\d+$/).optional().transform(Number),
    limit: z.string().regex(/^\d+$/).optional().transform(Number),
  }),
});

// ─────────────────────────────────────────
// GET /api/v1/gifts/animations
// ─────────────────────────────────────────
router.get(
  "/animations",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const category = req.query.category as string | undefined;
      const animations = await starsGiftService.getAnimations(category);
      res.json({ success: true, data: { animations } });
    } catch (err) {
      next(err);
    }
  }
);

// ─────────────────────────────────────────
// POST /api/v1/gifts/send
// ─────────────────────────────────────────
router.post(
  "/send",
  validateRequest(SendGiftSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await starsGiftService.sendGift({
        fromUserId: req.user!.id,
        toUserId: req.body.toUserId,
        starsAmount: BigInt(req.body.starsAmount),
        animationId: req.body.animationId,
        message: req.body.message,
      });

      res.status(201).json({
        success: true,
        message: "Gift sent successfully! Recipient has 30 days to claim it.",
        data: {
          giftId: result.giftId,
          expiresAt: result.expiresAt,
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

// ─────────────────────────────────────────
// POST /api/v1/gifts/:giftId/claim
// ─────────────────────────────────────────
router.post(
  "/:giftId/claim",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await starsGiftService.claimGift(
        req.user!.id,
        req.params.giftId
      );

      res.json({
        success: true,
        message: `You received ${result.starsReceived} stars!`,
        data: {
          starsReceived: result.starsReceived.toString(),
          transactionId: result.transactionId,
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

// ─────────────────────────────────────────
// POST /api/v1/gifts/:giftId/reject
// ─────────────────────────────────────────
router.post(
  "/:giftId/reject",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await starsGiftService.rejectGift(req.user!.id, req.params.giftId);
      res.json({
        success: true,
        message: "Gift rejected. Stars returned to sender.",
      });
    } catch (err) {
      next(err);
    }
  }
);

// ─────────────────────────────────────────
// GET /api/v1/gifts/received
// ─────────────────────────────────────────
router.get(
  "/received",
  validateRequest(GetGiftsSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await starsGiftService.getReceivedGifts(
        req.user!.id,
        {
          status: req.query.status as any,
          page: req.query.page ? Number(req.query.page) : 1,
          limit: req.query.limit ? Number(req.query.limit) : 20,
        }
      );
      res.json({ success: true, data: result });
    } catch (err) {
      next(err);
    }
  }
);

// ─────────────────────────────────────────
// GET /api/v1/gifts/sent
// ─────────────────────────────────────────
router.get(
  "/sent",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await starsGiftService.getSentGifts(req.user!.id, {
        page: req.query.page ? Number(req.query.page) : 1,
        limit: req.query.limit ? Number(req.query.limit) : 20,
      });
      res.json({ success: true, data: result });
    } catch (err) {
      next(err);
    }
  }
);

// ─────────────────────────────────────────
// GET /api/v1/gifts/:giftId
// ─────────────────────────────────────────
router.get(
  "/:giftId",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const gift = await starsGiftService.getGiftDetails(
        req.params.giftId,
        req.user!.id
      );
      res.json({
        success: true,
        data: {
          ...gift,
          starsAmount: gift.starsAmount.toString(),
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
