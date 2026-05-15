import {
  PrismaClient,
  StoryType,
  StoryStatus,
  StoryPrivacy,
  ProcessingStatus,
} from "@prisma/client";
import { mediaProcessingService } from "./MediaProcessingService";
import { storageService } from "../../lib/storage";
import { AppError } from "../../lib/errors";
import { EventBus } from "../../lib/eventBus";
import { redis } from "../../lib/redis";
import { prisma } from "../../lib/prisma";

// ─────────────────────────────────────────
// Types
// ─────────────────────────────────────────
export interface CreateStoryOptions {
  userId: string;
  isPremium: boolean;
  file: Express.Multer.File;
  caption?: string;
  privacyType?: StoryPrivacy;
  allowedUserIds?: string[];
  closeFriendsOnly?: boolean;
}

export interface StoryUploadResult {
  storyId: string;
  status: StoryStatus;
  thumbnailUrl: string | null;
  expiresAt: Date;
  processingJobId: string;
}

// ─────────────────────────────────────────
// Per-day upload limits
// ─────────────────────────────────────────
const UPLOAD_LIMITS = {
  FREE: { storiesPerDay: 3, captionLength: 200 },
  PREMIUM: { storiesPerDay: 10, captionLength: 2048 },
} as const;

// Story expiry durations
const EXPIRY_HOURS = {
  FREE: 24,
  PREMIUM: 48,
} as const;

// ─────────────────────────────────────────
// Story Upload Service
// ─────────────────────────────────────────
export class StoryUploadService {

  // ─────────────────────────────────────
  // CREATE STORY
  // Main entry point for story creation
  // ─────────────────────────────────────
  async createStory(
    options: CreateStoryOptions
  ): Promise<StoryUploadResult> {
    const {
      userId,
      isPremium,
      file,
      caption,
      privacyType = StoryPrivacy.CONTACTS,
      allowedUserIds = [],
      closeFriendsOnly = false,
    } = options;

    // 1. Check daily upload limit
    await this.checkDailyLimit(userId, isPremium);

    // 2. Validate caption length
    const maxCaption = isPremium
      ? UPLOAD_LIMITS.PREMIUM.captionLength
      : UPLOAD_LIMITS.FREE.captionLength;
    if (caption && caption.length > maxCaption) {
      throw new AppError(
        "CAPTION_TOO_LONG",
        `Caption must be under ${maxCaption} characters`,
        400,
        { maxLength: maxCaption, actualLength: caption.length }
      );
    }

    // 3. Validate media
    mediaProcessingService.validateMedia(file, isPremium);

    // 4. Determine story type
    const storyType = file.mimetype.startsWith("video/")
      ? StoryType.VIDEO
      : StoryType.PHOTO;

    // 5. Calculate expiry
    const expiryHours = isPremium
      ? EXPIRY_HOURS.PREMIUM
      : EXPIRY_HOURS.FREE;
    const expiresAt = new Date(
      Date.now() + expiryHours * 60 * 60 * 1000
    );

    // 6. Create story record (status = PROCESSING)
    const story = await prisma.$transaction(async (tx) => {
      const newStory = await tx.story.create({
        data: {
          userId,
          type: storyType,
          status: StoryStatus.PROCESSING,
          caption: caption ?? null,
          privacyType: closeFriendsOnly
            ? StoryPrivacy.CLOSE_FRIENDS
            : privacyType,
          expiresAt,
        },
      });

      // Create processing job
      const processingJob = await tx.storyProcessingJob.create({
        data: {
          storyId: newStory.id,
          status: ProcessingStatus.QUEUED,
          priority: isPremium ? 1 : 5, // premium gets priority
          currentStep: "queued",
        },
      });

      // Create privacy rules for selected users
      if (
        privacyType === StoryPrivacy.SELECTED_USERS &&
        allowedUserIds.length > 0
      ) {
        await tx.storyPrivacyRule.createMany({
          data: allowedUserIds.map((uid) => ({
            storyId: newStory.id,
            ruleType: "allow_user",
            userId: uid,
          })),
        });
      }

      return { newStory, processingJob };
    });

    // 7. Upload original to temp storage
    const tempKey = `${story.newStory.id}/original${this.getExtension(file.mimetype)}`;
    await storageService.uploadFile(
      storageService.BUCKETS.STORIES_TEMP,
      tempKey,
      file.buffer,
      file.mimetype
    );

    // 8. Queue processing (async — don't wait)
    this.processStoryAsync(story.newStory.id, file.buffer, file.mimetype, isPremium)
      .catch((err) => {
        console.error(`❌ Story processing failed for ${story.newStory.id}:`, err);
      });

    // 9. Invalidate feed caches for followers
    await this.invalidateFeedCaches(userId);

    await EventBus.emit("story.created", {
      storyId: story.newStory.id,
      userId,
      type: storyType,
      expiresAt,
    });

    return {
      storyId: story.newStory.id,
      status: StoryStatus.PROCESSING,
      thumbnailUrl: null, // will be available after processing
      expiresAt,
      processingJobId: story.processingJob.id,
    };
  }

  // ─────────────────────────────────────
  // GET PROCESSING STATUS
  // Client polls this while story processes
  // ─────────────────────────────────────
  async getProcessingStatus(storyId: string, userId: string) {
    const story = await prisma.story.findFirst({
      where: { id: storyId, userId, isDeleted: false },
      include: {
        processingJob: true,
        mediaVariants: {
          select: { quality: true, url: true, width: true, height: true },
        },
      },
    });

    if (!story) {
      throw new AppError("STORY_NOT_FOUND", "Story not found", 404);
    }

    return {
      storyId: story.id,
      status: story.status,
      processingStatus: story.processingJob?.status,
      progress: story.processingJob?.progress ?? 0,
      currentStep: story.processingJob?.currentStep,
      thumbnailUrl: story.thumbnailUrl,
      mediaVariants: story.mediaVariants,
      errorMessage: story.processingJob?.errorMessage,
    };
  }

  // ─────────────────────────────────────
  // DELETE STORY
  // ─────────────────────────────────────
  async deleteStory(storyId: string, userId: string): Promise<void> {
    const story = await prisma.story.findFirst({
      where: { id: storyId, userId, isDeleted: false },
    });

    if (!story) {
      throw new AppError("STORY_NOT_FOUND", "Story not found", 404);
    }

    await prisma.story.update({
      where: { id: storyId },
      data: {
        isDeleted: true,
        deletedAt: new Date(),
        status: StoryStatus.DELETED,
      },
    });

    // Queue media cleanup (async)
    this.cleanupStoryMedia(storyId).catch(console.error);

    await this.invalidateFeedCaches(userId);
    await EventBus.emit("story.deleted", { storyId, userId });
  }

  // ─────────────────────────────────────
  // UPDATE PRIVACY
  // ─────────────────────────────────────
  async updatePrivacy(
    storyId: string,
    userId: string,
    privacyType: StoryPrivacy,
    allowedUserIds?: string[]
  ): Promise<void> {
    const story = await prisma.story.findFirst({
      where: { id: storyId, userId, isDeleted: false },
    });

    if (!story) {
      throw new AppError("STORY_NOT_FOUND", "Story not found", 404);
    }

    await prisma.$transaction(async (tx) => {
      await tx.story.update({
        where: { id: storyId },
        data: { privacyType },
      });

      // Reset privacy rules
      await tx.storyPrivacyRule.deleteMany({
        where: { storyId },
      });

      // Add new rules if SELECTED_USERS
      if (
        privacyType === StoryPrivacy.SELECTED_USERS &&
        allowedUserIds?.length
      ) {
        await tx.storyPrivacyRule.createMany({
          data: allowedUserIds.map((uid) => ({
            storyId,
            ruleType: "allow_user",
            userId: uid,
          })),
        });
      }
    });

    await this.invalidateFeedCaches(userId);
  }

  // ─────────────────────────────────────
  // GET USER STORIES
  // ─────────────────────────────────────
  async getUserStories(
    targetUserId: string,
    viewerId: string
  ) {
    const stories = await prisma.story.findMany({
      where: {
        userId: targetUserId,
        isDeleted: false,
        isArchived: false,
        status: StoryStatus.ACTIVE,
        expiresAt: { gt: new Date() },
      },
      include: {
        mediaVariants: {
          select: { quality: true, url: true, width: true, height: true },
        },
        views: {
          where: { viewerId },
          select: { viewedAt: true },
        },
      },
      orderBy: { createdAt: "asc" },
    });

    // Filter by privacy
    const accessible = await this.filterByPrivacy(stories, viewerId);

    return accessible.map((story) => ({
      id: story.id,
      type: story.type,
      mediaUrl: story.mediaUrl,
      thumbnailUrl: story.thumbnailUrl,
      caption: story.caption,
      viewCount: story.viewCount,
      reactionCount: story.reactionCount,
      expiresAt: story.expiresAt,
      createdAt: story.createdAt,
      isViewed: story.views.length > 0,
      viewedAt: story.views[0]?.viewedAt ?? null,
      mediaVariants: story.mediaVariants,
    }));
  }

  // ─────────────────────────────────────
  // GET STORY BY ID
  // ─────────────────────────────────────
  async getStoryById(storyId: string, viewerId: string) {
    const story = await prisma.story.findFirst({
      where: { id: storyId, isDeleted: false },
      include: {
        mediaVariants: true,
        views: {
          where: { viewerId },
          select: { viewedAt: true },
        },
        privacyRules: true,
      },
    });

    if (!story) {
      throw new AppError("STORY_NOT_FOUND", "Story not found", 404);
    }

    // Check privacy
    const canAccess = await this.checkStoryAccess(story, viewerId);
    if (!canAccess) {
      throw new AppError(
        "STORY_ACCESS_DENIED",
        "You don't have access to this story",
        403
      );
    }

    return {
      id: story.id,
      userId: story.userId,
      type: story.type,
      status: story.status,
      mediaUrl: story.mediaUrl,
      thumbnailUrl: story.thumbnailUrl,
      caption: story.caption,
      width: story.width,
      height: story.height,
      durationSec: story.durationSec,
      viewCount: story.viewCount,
      reactionCount: story.reactionCount,
      replyCount: story.replyCount,
      expiresAt: story.expiresAt,
      createdAt: story.createdAt,
      isViewed: story.views.length > 0,
      privacyType: story.privacyType,
      mediaVariants: story.mediaVariants,
    };
  }

  // ─────────────────────────────────────
  // MARK STORY SEEN
  // ─────────────────────────────────────
  async markStorySeen(
    storyId: string,
    viewerId: string,
    viewDurationMs?: number
  ): Promise<void> {
    const story = await prisma.story.findFirst({
      where: { id: storyId, isDeleted: false, status: StoryStatus.ACTIVE },
    });

    if (!story) return;

    // Don't record own views
    if (story.userId === viewerId) return;

    // Check stealth mode
    const isStealthy = await this.isStealthModeActive(viewerId);

    await prisma.$transaction(async (tx) => {
      // Upsert view record
      const existingView = await tx.storyView.findUnique({
        where: { storyId_viewerId: { storyId, viewerId } },
      });

      if (!existingView) {
        await tx.storyView.create({
          data: {
            storyId,
            viewerId,
            viewDurationMs,
            isStealthView: isStealthy,
            source: "feed",
          },
        });

        // Increment view counters only for non-stealth views
        if (!isStealthy) {
          await tx.story.update({
            where: { id: storyId },
            data: {
              viewCount: { increment: 1 },
              uniqueViewCount: { increment: 1 },
            },
          });
        }
      }
    });
  }

  // ─────────────────────────────────────
  // PRIVATE: Process story async
  // ─────────────────────────────────────
  private async processStoryAsync(
    storyId: string,
    buffer: Buffer,
    mimeType: string,
    isPremium: boolean
  ): Promise<void> {
    const job = await prisma.storyProcessingJob.findUnique({
      where: { storyId },
    });
    if (!job) return;

    try {
      // Update job status
      await prisma.storyProcessingJob.update({
        where: { storyId },
        data: {
          status: ProcessingStatus.PROCESSING,
          startedAt: new Date(),
          currentStep: "processing",
          progress: 10,
          attempts: { increment: 1 },
        },
      });

      let processed;
      const isVideo = mimeType.startsWith("video/");

      if (isVideo) {
        await prisma.storyProcessingJob.update({
          where: { storyId },
          data: { currentStep: "transcoding", progress: 20 },
        });
        processed = await mediaProcessingService.processVideo(
          buffer, storyId, isPremium
        );
      } else {
        await prisma.storyProcessingJob.update({
          where: { storyId },
          data: { currentStep: "optimizing", progress: 30 },
        });
        processed = await mediaProcessingService.processImage(
          buffer, storyId, isPremium
        );
      }

      // Update progress
      await prisma.storyProcessingJob.update({
        where: { storyId },
        data: { currentStep: "uploading_variants", progress: 80 },
      });

      // Save all variants to DB
      await prisma.$transaction(async (tx) => {
        // Create media variants
        if (processed.variants.length > 0) {
          await tx.storyMediaVariant.createMany({
            data: processed.variants.map((v) => ({
              storyId,
              quality: v.quality,
              url: v.url,
              width: v.width,
              height: v.height,
              fileSizeMb: v.fileSizeMb,
              bitrate: v.bitrate,
            })),
          });
        }

        // Update story with final data
        await tx.story.update({
          where: { id: storyId },
          data: {
            status: StoryStatus.ACTIVE,
            mediaUrl: processed.variants[0]?.url ?? null,
            thumbnailUrl: processed.thumbnailUrl,
            width: processed.metadata.width,
            height: processed.metadata.height,
            durationSec: processed.metadata.durationSec ?? null,
            fileSizeMb: processed.metadata.fileSizeMb,
            mimeType: processed.metadata.mimeType,
            processedUrls: Object.fromEntries(
              processed.variants.map((v) => [v.quality, v.url])
            ),
          },
        });

        // Mark job complete
        await tx.storyProcessingJob.update({
          where: { storyId },
          data: {
            status: ProcessingStatus.COMPLETED,
            completedAt: new Date(),
            progress: 100,
            currentStep: "completed",
          },
        });
      });

      // Clean up temp files
      await storageService.deleteFile(
        storageService.BUCKETS.STORIES_TEMP,
        `${storyId}/original${this.getExtension(mimeType)}`
      ).catch(() => {});

      await EventBus.emit("story.processing_complete", {
        storyId,
        userId: (await prisma.story.findUnique({
          where: { id: storyId },
          select: { userId: true },
        }))?.userId,
      });

    } catch (err) {
      // Mark job as failed
      await prisma.$transaction(async (tx) => {
        await tx.storyProcessingJob.update({
          where: { storyId },
          data: {
            status: ProcessingStatus.FAILED,
            errorMessage: (err as Error).message,
            currentStep: "failed",
          },
        });

        await tx.story.update({
          where: { id: storyId },
          data: { status: StoryStatus.FAILED },
        });
      });

      await EventBus.emit("story.processing_failed", {
        storyId,
        error: (err as Error).message,
      });

      throw err;
    }
  }

  // ─────────────────────────────────────
  // PRIVATE: Check daily upload limit
  // ─────────────────────────────────────
  private async checkDailyLimit(
    userId: string,
    isPremium: boolean
  ): Promise<void> {
    const limit = isPremium
      ? UPLOAD_LIMITS.PREMIUM.storiesPerDay
      : UPLOAD_LIMITS.FREE.storiesPerDay;

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const todayCount = await prisma.story.count({
      where: {
        userId,
        createdAt: { gte: today },
        isDeleted: false,
        status: { not: StoryStatus.FAILED },
      },
    });

    if (todayCount >= limit) {
      throw new AppError(
        "DAILY_LIMIT_REACHED",
        `You can post ${limit} stories per day${!isPremium ? ". Upgrade to Premium for 10/day!" : ""}`,
        429,
        { limit, used: todayCount }
      );
    }
  }

  // ─────────────────────────────────────
  // PRIVATE: Filter stories by privacy
  // ─────────────────────────────────────
  private async filterByPrivacy(
    stories: any[],
    viewerId: string
  ): Promise<any[]> {
    const result = [];

    for (const story of stories) {
      const canAccess = await this.checkStoryAccess(story, viewerId);
      if (canAccess) result.push(story);
    }

    return result;
  }

  // ─────────────────────────────────────
  // PRIVATE: Check if viewer can access story
  // ─────────────────────────────────────
  private async checkStoryAccess(
    story: any,
    viewerId: string
  ): Promise<boolean> {
    // Owner can always see own stories
    if (story.userId === viewerId) return true;

    switch (story.privacyType) {
      case StoryPrivacy.EVERYONE:
        return true;

      case StoryPrivacy.CONTACTS:
        // Check if they are contacts (simplified — check mutual follow)
        return true; // TODO: implement contact check

      case StoryPrivacy.CLOSE_FRIENDS: {
        const isFriend = await prisma.closeFriend.findUnique({
          where: {
            userId_friendId: {
              userId: story.userId,
              friendId: viewerId,
            },
          },
        });
        return !!isFriend;
      }

      case StoryPrivacy.SELECTED_USERS: {
        const rule = story.privacyRules?.find(
          (r: any) => r.ruleType === "allow_user" && r.userId === viewerId
        );
        return !!rule;
      }

      case StoryPrivacy.NOBODY:
        return false;

      default:
        return false;
    }
  }

  // ─────────────────────────────────────
  // PRIVATE: Check stealth mode
  // ─────────────────────────────────────
  private async isStealthModeActive(userId: string): Promise<boolean> {
    const key = `stealth:${userId}`;
    const result = await redis.get(key);
    return result === "1";
  }

  // ─────────────────────────────────────
  // PRIVATE: Invalidate feed caches
  // ─────────────────────────────────────
  private async invalidateFeedCaches(userId: string): Promise<void> {
    // Invalidate own feed cache
    await redis.del(`story:feed:${userId}`);

    // In production: also invalidate followers' feed caches
    // This would require a follower list lookup
  }

  // ─────────────────────────────────────
  // PRIVATE: Clean up story media files
  // ─────────────────────────────────────
  private async cleanupStoryMedia(storyId: string): Promise<void> {
    const variants = await prisma.storyMediaVariant.findMany({
      where: { storyId },
    });

    // Delete all variant files from storage
    const deletePromises = variants.map((v) => {
      const bucket = storageService.BUCKETS.STORIES;
      const key = `${storyId}/${v.quality}.${v.url.split(".").pop()}`;
      return storageService.deleteFile(bucket, key).catch(() => {});
    });

    // Delete thumbnail
    deletePromises.push(
      storageService
        .deleteFile(
          storageService.BUCKETS.STORIES_THUMBNAILS,
          `${storyId}/thumbnail.webp`
        )
        .catch(() => {})
    );

    await Promise.all(deletePromises);
  }

  // ─────────────────────────────────────
  // PRIVATE: Get file extension from mime
  // ─────────────────────────────────────
  private getExtension(mimeType: string): string {
    const map: Record<string, string> = {
      "image/jpeg": ".jpg",
      "image/png": ".png",
      "image/webp": ".webp",
      "image/gif": ".gif",
      "video/mp4": ".mp4",
      "video/quicktime": ".mov",
      "video/webm": ".webm",
    };
    return map[mimeType] || ".bin";
  }
}

export const storyUploadService = new StoryUploadService();
