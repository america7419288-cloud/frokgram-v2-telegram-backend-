import cron from "node-cron";
import { StoryStatus, ProcessingStatus } from "@prisma/client";
import { storageService } from "../lib/storage";
import { EventBus } from "../lib/eventBus";
import { redis } from "../lib/redis";
import { prisma } from "../lib/prisma";

// ─────────────────────────────────────────
// JOB 1: Expire stories
// Runs every minute
// ─────────────────────────────────────────
cron.schedule("* * * * *", async () => {
  const expiredStories = await prisma.story.findMany({
    where: {
      status: StoryStatus.ACTIVE,
      expiresAt: { lte: new Date() },
      isDeleted: false,
    },
    take: 100,
  });

  if (expiredStories.length === 0) return;

  for (const story of expiredStories) {
    await prisma.story.update({
      where: { id: story.id },
      data: {
        status: StoryStatus.EXPIRED,
        isArchived: true,
        archivedAt: new Date(),
      },
    });

    // Invalidate feed caches
    await redis.del(`story:feed:${story.userId}`);

    await EventBus.emit("story.expired", {
      storyId: story.id,
      userId: story.userId,
    });
  }

  console.log(`⏰ Expired ${expiredStories.length} stories`);
});

// ─────────────────────────────────────────
// JOB 2: Retry failed processing jobs
// Runs every 15 minutes
// ─────────────────────────────────────────
cron.schedule("*/15 * * * *", async () => {
  const failedJobs = await prisma.storyProcessingJob.findMany({
    where: {
      status: ProcessingStatus.FAILED,
      attempts: { lt: 3 },
    },
    take: 20,
  });

  for (const job of failedJobs) {
    await prisma.storyProcessingJob.update({
      where: { id: job.id },
      data: {
        status: ProcessingStatus.QUEUED,
        currentStep: "retry_queued",
      },
    });

    console.log(`🔄 Re-queued failed story processing job: ${job.id}`);
  }
});

// ─────────────────────────────────────────
// JOB 3: Clean up deleted story media
// Runs every day at 3am
// ─────────────────────────────────────────
cron.schedule("0 3 * * *", async () => {
  console.log("🧹 Cleaning up deleted story media...");

  const deletedStories = await prisma.story.findMany({
    where: {
      isDeleted: true,
      deletedAt: {
        lte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000), // 7 days ago
      },
    },
    include: { mediaVariants: true },
    take: 100,
  });

  for (const story of deletedStories) {
    try {
      // Delete all variant files
      const keys = story.mediaVariants.map(
        (v) => `${story.id}/${v.quality}.${v.url.split(".").pop()}`
      );

      if (keys.length > 0) {
        await storageService.deleteFiles(
          storageService.BUCKETS.STORIES,
          keys
        );
      }

      // Delete thumbnail
      await storageService.deleteFile(
        storageService.BUCKETS.STORIES_THUMBNAILS,
        `${story.id}/thumbnail.webp`
      ).catch(() => {});

      // Delete media variant records
      await prisma.storyMediaVariant.deleteMany({
        where: { storyId: story.id },
      });

      console.log(`✅ Cleaned up media for story ${story.id}`);
    } catch (err) {
      console.error(`❌ Failed to clean story ${story.id}:`, err);
    }
  }
});

// ─────────────────────────────────────────
// JOB 4: Clean up expired feed caches
// Runs every hour
// ─────────────────────────────────────────
cron.schedule("0 * * * *", async () => {
  const expiredCaches = await prisma.storyFeedCache.findMany({
    where: { expiresAt: { lte: new Date() } },
    take: 500,
  });

  if (expiredCaches.length > 0) {
    await prisma.storyFeedCache.deleteMany({
      where: {
        id: { in: expiredCaches.map((c) => c.id) },
      },
    });
  }
});

console.log("✅ Story background jobs initialized");
