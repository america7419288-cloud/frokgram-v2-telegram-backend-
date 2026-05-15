import { Router, Request, Response, NextFunction } from "express";
import multer from "multer";
import { z } from "zod";
import { storyUploadService } from "../services/stories/StoryUploadService";
import { storyFeedService } from "../services/stories/StoryFeedService";
import { authMiddleware } from "../middleware/authMiddleware";
import { attachPremiumStatus } from "../middleware/premiumMiddleware";
import { validateRequest } from "../middleware/validateRequest";
import { AppError } from "../lib/errors";
import { StoryPrivacy } from "@prisma/client";

const router = Router();

// ── Multer config (in-memory for now) ────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 500 * 1024 * 1024, // 500MB hard limit (premium)
  },
  fileFilter: (_req, file, cb) => {
    const allowed = [
      "image/jpeg", "image/png", "image/webp", "image/gif",
      "video/mp4", "video/quicktime", "video/webm",
    ];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new AppError("INVALID_FILE_TYPE", "File type not supported", 400) as any);
    }
  },
});

router.use(authMiddleware);
router.use(attachPremiumStatus);

// ── Schemas ────────────────────────────────
const CreateStorySchema = z.object({
  body: z.object({
    caption: z.string().max(2048).optional(),
    privacyType: z.enum([
      "EVERYONE", "CONTACTS", "CLOSE_FRIENDS",
      "SELECTED_USERS", "NOBODY",
    ]).optional(),
    allowedUserIds: z.array(z.string()).optional(),
    closeFriendsOnly: z.boolean().optional(),
  }),
});

const UpdatePrivacySchema = z.object({
  body: z.object({
    privacyType: z.enum([
      "EVERYONE", "CONTACTS", "CLOSE_FRIENDS",
      "SELECTED_USERS", "NOBODY",
    ]),
    allowedUserIds: z.array(z.string()).optional(),
  }),
});

const MarkSeenSchema = z.object({
  body: z.object({
    viewDurationMs: z.number().int().positive().optional(),
  }),
});

// ─────────────────────────────────────────
// POST /api/v1/stories/create
// Upload a new story
// ─────────────────────────────────────────
router.post(
  "/create",
  upload.single("media"),
  validateRequest(CreateStorySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.file) {
        throw new AppError("NO_MEDIA", "Media file is required", 400);
      }

      const isPremium = req.premiumStatus?.isPremium ?? false;

      const result = await storyUploadService.createStory({
        userId: req.user!.id,
        isPremium,
        file: req.file,
        caption: req.body.caption,
        privacyType: req.body.privacyType as StoryPrivacy,
        allowedUserIds: req.body.allowedUserIds,
        closeFriendsOnly: req.body.closeFriendsOnly,
      });

      res.status(201).json({
        success: true,
        message: "Story uploaded! Processing in progress...",
        data: result,
      });
    } catch (err) {
      next(err);
    }
  }
);

// ─────────────────────────────────────────
// GET /api/v1/stories/feed
// Get story feed (story rings)
// ─────────────────────────────────────────
router.get(
  "/feed",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const cursor = req.query.cursor as string | undefined;
      const limit = Math.min(Number(req.query.limit) || 20, 50);

      const feed = await storyFeedService.getStoryFeed(
        req.user!.id,
        cursor,
        limit
      );

      res.json({ success: true, data: feed });
    } catch (err) {
      next(err);
    }
  }
);

// ─────────────────────────────────────────
// GET /api/v1/stories/user/:userId
// Get all active stories from a user
// ─────────────────────────────────────────
router.get(
  "/user/:userId",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const stories = await storyUploadService.getUserStories(
        req.params.userId,
        req.user!.id
      );

      res.json({ success: true, data: { stories } });
    } catch (err) {
      next(err);
    }
  }
);

// ─────────────────────────────────────────
// GET /api/v1/stories/:storyId
// Get single story
// ─────────────────────────────────────────
router.get(
  "/:storyId",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const story = await storyUploadService.getStoryById(
        req.params.storyId,
        req.user!.id
      );

      res.json({ success: true, data: story });
    } catch (err) {
      next(err);
    }
  }
);

// ─────────────────────────────────────────
// POST /api/v1/stories/:storyId/seen
// Mark story as seen
// ─────────────────────────────────────────
router.post(
  "/:storyId/seen",
  validateRequest(MarkSeenSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await storyUploadService.markStorySeen(
        req.params.storyId,
        req.user!.id,
        req.body.viewDurationMs
      );

      res.json({ success: true });
    } catch (err) {
      next(err);
    }
  }
);

// ─────────────────────────────────────────
// DELETE /api/v1/stories/:storyId
// Delete a story
// ─────────────────────────────────────────
router.delete(
  "/:storyId",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await storyUploadService.deleteStory(
        req.params.storyId,
        req.user!.id
      );

      res.json({ success: true, message: "Story deleted" });
    } catch (err) {
      next(err);
    }
  }
);

// ─────────────────────────────────────────
// PUT /api/v1/stories/:storyId/privacy
// Update story privacy
// ─────────────────────────────────────────
router.put(
  "/:storyId/privacy",
  validateRequest(UpdatePrivacySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await storyUploadService.updatePrivacy(
        req.params.storyId,
        req.user!.id,
        req.body.privacyType,
        req.body.allowedUserIds
      );

      res.json({ success: true, message: "Privacy updated" });
    } catch (err) {
      next(err);
    }
  }
);

// ─────────────────────────────────────────
// GET /api/v1/stories/:storyId/processing-status
// Poll processing status
// ─────────────────────────────────────────
router.get(
  "/:storyId/processing-status",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const status = await storyUploadService.getProcessingStatus(
        req.params.storyId,
        req.user!.id
      );

      res.json({ success: true, data: status });
    } catch (err) {
      next(err);
    }
  }
);

// ─────────────────────────────────────────
// Close Friends Routes
// ─────────────────────────────────────────
router.get(
  "/close-friends/list",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const friends = await storyFeedService.getCloseFriends(req.user!.id);
      res.json({ success: true, data: { friends } });
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  "/close-friends/:friendId",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await storyFeedService.addCloseFriend(
        req.user!.id,
        req.params.friendId
      );
      res.json({ success: true, message: "Added to close friends" });
    } catch (err) {
      next(err);
    }
  }
);

router.delete(
  "/close-friends/:friendId",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await storyFeedService.removeCloseFriend(
        req.user!.id,
        req.params.friendId
      );
      res.json({ success: true, message: "Removed from close friends" });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
