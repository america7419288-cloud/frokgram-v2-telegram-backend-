import { describe, it, expect, beforeEach, afterAll, jest } from "@jest/globals";
import { StoryStatus } from "@prisma/client";
import { StoryUploadService } from "../services/stories/StoryUploadService";
import { StoryFeedService } from "../services/stories/StoryFeedService";
import { prisma } from "../lib/prisma";
import { storageService } from "../lib/storage";
import { mediaProcessingService } from "../services/stories/MediaProcessingService";

// Mock storage service
jest.mock("../lib/storage", () => ({
  storageService: {
    uploadFile: jest.fn<any>().mockResolvedValue("http://localhost:9000/stories/test.jpg"),
    deleteFile: jest.fn<any>().mockResolvedValue(undefined),
    deleteFiles: jest.fn<any>().mockResolvedValue(undefined),
    BUCKETS: {
      STORIES: "stories",
      STORIES_THUMBNAILS: "stories-thumbnails",
      STORIES_TEMP: "stories-temp",
    },
  },
}));

// Mock media processing service
jest.mock("../services/stories/MediaProcessingService", () => ({
  mediaProcessingService: {
    validateMedia: jest.fn<any>().mockReturnValue(undefined),
    processImage: jest.fn<any>().mockResolvedValue({
      thumbnailUrl: "http://thumb.url",
      variants: [{ quality: "original", url: "http://full.url", width: 1080, height: 1920, fileSizeMb: 1 }],
      metadata: { width: 1080, height: 1920, fileSizeMb: 1, mimeType: "image/webp" },
    }),
    processVideo: jest.fn<any>().mockResolvedValue({
      thumbnailUrl: "http://thumb.url",
      variants: [{ quality: "720p", url: "http://video.url", width: 1280, height: 720, fileSizeMb: 5 }],
      metadata: { width: 1280, height: 720, durationSec: 15, fileSizeMb: 5, mimeType: "video/mp4" },
    }),
  },
}));

const uploadService = new StoryUploadService();
const feedService = new StoryFeedService();

// Mock processStoryAsync to prevent background jobs from hanging tests
// @ts-ignore
uploadService.processStoryAsync = jest.fn().mockResolvedValue(undefined);

const TEST_USER = "test-story-user-1";
const TEST_VIEWER = "test-story-viewer-1";

async function cleanupTestData() {
  const stories = await prisma.story.findMany({
    where: { userId: { in: [TEST_USER, TEST_VIEWER] } },
  });
  const storyIds = stories.map((s) => s.id);

  if (storyIds.length > 0) {
    await prisma.storyView.deleteMany({ where: { storyId: { in: storyIds } } });
    await prisma.storyReaction.deleteMany({ where: { storyId: { in: storyIds } } });
    await prisma.storyPrivacyRule.deleteMany({ where: { storyId: { in: storyIds } } });
    await prisma.storyMediaVariant.deleteMany({ where: { storyId: { in: storyIds } } });
    await prisma.storyProcessingJob.deleteMany({ where: { storyId: { in: storyIds } } });
    await prisma.story.deleteMany({ where: { id: { in: storyIds } } });
  }

  await prisma.closeFriend.deleteMany({
    where: { userId: { in: [TEST_USER, TEST_VIEWER] } },
  });
}

// ─────────────────────────────────────────
describe("Day 5 — Stories Upload & Feed", () => {
  beforeEach(async () => {
    await cleanupTestData();
  });

  afterAll(async () => {
    await cleanupTestData();
    await prisma.$disconnect();
  });

  // ─────────────────────────────────────
  describe("StoryUploadService", () => {
    it("should create a story in PROCESSING status", async () => {
      const mockFile: Express.Multer.File = {
        fieldname: "media",
        originalname: "test.jpg",
        encoding: "7bit",
        mimetype: "image/jpeg",
        buffer: Buffer.from("fake-image-data"),
        size: 1024,
        stream: null as any,
        destination: "",
        filename: "",
        path: "",
      };

      const result = await uploadService.createStory({
        userId: TEST_USER,
        isPremium: false,
        file: mockFile,
        caption: "Test story",
      });

      expect(result.storyId).toBeDefined();
      expect(result.status).toBe(StoryStatus.PROCESSING);
      expect(result.expiresAt).toBeDefined();

      // Check DB
      const story = await prisma.story.findUnique({
        where: { id: result.storyId },
      });
      expect(story?.status).toBe(StoryStatus.PROCESSING);
      expect(story?.caption).toBe("Test story");
    });

    it("should reject file with invalid mime type", async () => {
      const mockFile: Express.Multer.File = {
        fieldname: "media",
        originalname: "test.pdf",
        encoding: "7bit",
        mimetype: "application/pdf",
        buffer: Buffer.from("fake-pdf"),
        size: 1024,
        stream: null as any,
        destination: "",
        filename: "",
        path: "",
      };

      await expect(
        uploadService.createStory({
          userId: TEST_USER,
          isPremium: false,
          file: mockFile,
        })
      ).rejects.toThrow("UNSUPPORTED_MEDIA_TYPE");
    });

    it("should enforce daily story limit for free users", async () => {
      const mockFile: Express.Multer.File = {
        fieldname: "media",
        originalname: "test.jpg",
        encoding: "7bit",
        mimetype: "image/jpeg",
        buffer: Buffer.from("fake-image"),
        size: 1024,
        stream: null as any,
        destination: "",
        filename: "",
        path: "",
      };

      // Create 3 stories (free limit)
      for (let i = 0; i < 3; i++) {
        await uploadService.createStory({
          userId: TEST_USER,
          isPremium: false,
          file: mockFile,
        });
      }

      // 4th should fail
      try {
        await uploadService.createStory({
          userId: TEST_USER,
          isPremium: false,
          file: mockFile,
        });
        throw new Error("Should have failed");
      } catch (err: any) {
        expect(err.name).toBe("DAILY_LIMIT_REACHED");
      }
    });

    it("should allow premium users 10 stories per day", async () => {
      const mockFile: Express.Multer.File = {
        fieldname: "media",
        originalname: "test.jpg",
        encoding: "7bit",
        mimetype: "image/jpeg",
        buffer: Buffer.from("fake-image"),
        size: 1024,
        stream: null as any,
        destination: "",
        filename: "",
        path: "",
      };

      // Premium: should allow more than 3
      for (let i = 0; i < 5; i++) {
        const result = await uploadService.createStory({
          userId: TEST_USER,
          isPremium: true,
          file: mockFile,
        });
        expect(result.storyId).toBeDefined();
      }
    });

    it("should set 48h expiry for premium, 24h for free", async () => {
      const mockFile: Express.Multer.File = {
        fieldname: "media",
        originalname: "test.jpg",
        encoding: "7bit",
        mimetype: "image/jpeg",
        buffer: Buffer.from("fake"),
        size: 100,
        stream: null as any,
        destination: "",
        filename: "",
        path: "",
      };

      const freeResult = await uploadService.createStory({
        userId: TEST_USER,
        isPremium: false,
        file: mockFile,
      });

      const hoursUntilExpiry =
        (freeResult.expiresAt.getTime() - Date.now()) / (1000 * 60 * 60);
      expect(hoursUntilExpiry).toBeCloseTo(24, 0);
    });
  });

  // ─────────────────────────────────────
  describe("Close Friends", () => {
    it("should add and remove close friends", async () => {
      await feedService.addCloseFriend(TEST_USER, TEST_VIEWER);

      const friends = await feedService.getCloseFriends(TEST_USER);
      expect(friends).toHaveLength(1);
      expect(friends[0].friendId).toBe(TEST_VIEWER);

      await feedService.removeCloseFriend(TEST_USER, TEST_VIEWER);

      const friendsAfter = await feedService.getCloseFriends(TEST_USER);
      expect(friendsAfter).toHaveLength(0);
    });
  });
});
