-- CreateEnum
CREATE TYPE "StoryType" AS ENUM ('PHOTO', 'VIDEO', 'TEXT', 'BOOMERANG');

-- CreateEnum
CREATE TYPE "StoryStatus" AS ENUM ('PROCESSING', 'ACTIVE', 'EXPIRED', 'ARCHIVED', 'DELETED', 'FAILED');

-- CreateEnum
CREATE TYPE "StoryPrivacy" AS ENUM ('EVERYONE', 'CONTACTS', 'CLOSE_FRIENDS', 'SELECTED_USERS', 'NOBODY');

-- CreateEnum
CREATE TYPE "ProcessingStatus" AS ENUM ('QUEUED', 'PROCESSING', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateTable
CREATE TABLE "stories" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "StoryType" NOT NULL DEFAULT 'PHOTO',
    "status" "StoryStatus" NOT NULL DEFAULT 'PROCESSING',
    "mediaUrl" TEXT,
    "originalUrl" TEXT,
    "thumbnailUrl" TEXT,
    "processedUrls" JSONB,
    "width" INTEGER,
    "height" INTEGER,
    "durationSec" INTEGER,
    "fileSizeMb" DOUBLE PRECISION,
    "mimeType" TEXT,
    "caption" VARCHAR(2048),
    "entities" JSONB,
    "privacyType" "StoryPrivacy" NOT NULL DEFAULT 'CONTACTS',
    "viewCount" INTEGER NOT NULL DEFAULT 0,
    "uniqueViewCount" INTEGER NOT NULL DEFAULT 0,
    "reactionCount" INTEGER NOT NULL DEFAULT 0,
    "replyCount" INTEGER NOT NULL DEFAULT 0,
    "repostCount" INTEGER NOT NULL DEFAULT 0,
    "isPinned" BOOLEAN NOT NULL DEFAULT false,
    "isArchived" BOOLEAN NOT NULL DEFAULT false,
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,
    "isPremiumOnly" BOOLEAN NOT NULL DEFAULT false,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "archivedAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "stories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "story_privacy_rules" (
    "id" TEXT NOT NULL,
    "storyId" TEXT NOT NULL,
    "ruleType" TEXT NOT NULL,
    "userId" TEXT,
    "listId" TEXT,

    CONSTRAINT "story_privacy_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "story_media_variants" (
    "id" TEXT NOT NULL,
    "storyId" TEXT NOT NULL,
    "quality" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "fileSizeMb" DOUBLE PRECISION,
    "bitrate" INTEGER,
    "codec" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "story_media_variants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "story_processing_jobs" (
    "id" TEXT NOT NULL,
    "storyId" TEXT NOT NULL,
    "status" "ProcessingStatus" NOT NULL DEFAULT 'QUEUED',
    "priority" INTEGER NOT NULL DEFAULT 5,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "progress" INTEGER NOT NULL DEFAULT 0,
    "currentStep" TEXT,
    "errorMessage" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "story_processing_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "story_views" (
    "id" TEXT NOT NULL,
    "storyId" TEXT NOT NULL,
    "viewerId" TEXT NOT NULL,
    "viewedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "viewDurationMs" INTEGER,
    "source" TEXT,
    "isStealthView" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "story_views_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "story_reactions" (
    "id" TEXT NOT NULL,
    "storyId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "emoji" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "story_reactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "story_replies" (
    "id" TEXT NOT NULL,
    "storyId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "messageText" VARCHAR(2048),
    "mediaUrl" TEXT,
    "isRead" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "story_replies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "close_friends" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "friendId" TEXT NOT NULL,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "close_friends_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "story_feed_cache" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "feedData" JSONB NOT NULL,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "story_feed_cache_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "stories_userId_idx" ON "stories"("userId");

-- CreateIndex
CREATE INDEX "stories_userId_status_idx" ON "stories"("userId", "status");

-- CreateIndex
CREATE INDEX "stories_expiresAt_idx" ON "stories"("expiresAt");

-- CreateIndex
CREATE INDEX "stories_isDeleted_isArchived_idx" ON "stories"("isDeleted", "isArchived");

-- CreateIndex
CREATE INDEX "stories_createdAt_idx" ON "stories"("createdAt");

-- CreateIndex
CREATE INDEX "story_privacy_rules_storyId_idx" ON "story_privacy_rules"("storyId");

-- CreateIndex
CREATE INDEX "story_media_variants_storyId_idx" ON "story_media_variants"("storyId");

-- CreateIndex
CREATE UNIQUE INDEX "story_media_variants_storyId_quality_key" ON "story_media_variants"("storyId", "quality");

-- CreateIndex
CREATE UNIQUE INDEX "story_processing_jobs_storyId_key" ON "story_processing_jobs"("storyId");

-- CreateIndex
CREATE INDEX "story_processing_jobs_status_idx" ON "story_processing_jobs"("status");

-- CreateIndex
CREATE INDEX "story_processing_jobs_priority_status_idx" ON "story_processing_jobs"("priority", "status");

-- CreateIndex
CREATE INDEX "story_views_storyId_idx" ON "story_views"("storyId");

-- CreateIndex
CREATE INDEX "story_views_viewerId_idx" ON "story_views"("viewerId");

-- CreateIndex
CREATE INDEX "story_views_storyId_viewedAt_idx" ON "story_views"("storyId", "viewedAt");

-- CreateIndex
CREATE UNIQUE INDEX "story_views_storyId_viewerId_key" ON "story_views"("storyId", "viewerId");

-- CreateIndex
CREATE INDEX "story_reactions_storyId_idx" ON "story_reactions"("storyId");

-- CreateIndex
CREATE UNIQUE INDEX "story_reactions_storyId_userId_key" ON "story_reactions"("storyId", "userId");

-- CreateIndex
CREATE INDEX "story_replies_storyId_idx" ON "story_replies"("storyId");

-- CreateIndex
CREATE INDEX "story_replies_userId_idx" ON "story_replies"("userId");

-- CreateIndex
CREATE INDEX "close_friends_userId_idx" ON "close_friends"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "close_friends_userId_friendId_key" ON "close_friends"("userId", "friendId");

-- CreateIndex
CREATE UNIQUE INDEX "story_feed_cache_userId_key" ON "story_feed_cache"("userId");

-- CreateIndex
CREATE INDEX "story_feed_cache_userId_idx" ON "story_feed_cache"("userId");

-- CreateIndex
CREATE INDEX "story_feed_cache_expiresAt_idx" ON "story_feed_cache"("expiresAt");

-- AddForeignKey
ALTER TABLE "story_privacy_rules" ADD CONSTRAINT "story_privacy_rules_storyId_fkey" FOREIGN KEY ("storyId") REFERENCES "stories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "story_media_variants" ADD CONSTRAINT "story_media_variants_storyId_fkey" FOREIGN KEY ("storyId") REFERENCES "stories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "story_processing_jobs" ADD CONSTRAINT "story_processing_jobs_storyId_fkey" FOREIGN KEY ("storyId") REFERENCES "stories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "story_views" ADD CONSTRAINT "story_views_storyId_fkey" FOREIGN KEY ("storyId") REFERENCES "stories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "story_reactions" ADD CONSTRAINT "story_reactions_storyId_fkey" FOREIGN KEY ("storyId") REFERENCES "stories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "story_replies" ADD CONSTRAINT "story_replies_storyId_fkey" FOREIGN KEY ("storyId") REFERENCES "stories"("id") ON DELETE CASCADE ON UPDATE CASCADE;
