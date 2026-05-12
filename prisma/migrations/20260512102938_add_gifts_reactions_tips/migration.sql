-- CreateEnum
CREATE TYPE "GiftRarity" AS ENUM ('COMMON', 'UNCOMMON', 'RARE', 'EPIC', 'LEGENDARY');

-- CreateEnum
CREATE TYPE "GiftStatus" AS ENUM ('PENDING', 'CLAIMED', 'REJECTED', 'EXPIRED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "SettlementStatus" AS ENUM ('PENDING', 'PROCESSING', 'SETTLED', 'FAILED');

-- CreateTable
CREATE TABLE "gift_animations" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "lottieUrl" TEXT NOT NULL,
    "thumbnailUrl" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "rarity" "GiftRarity" NOT NULL DEFAULT 'COMMON',
    "priceStars" BIGINT NOT NULL,
    "isAvailable" BOOLEAN NOT NULL DEFAULT true,
    "isLimited" BOOLEAN NOT NULL DEFAULT false,
    "availableUntil" TIMESTAMP(3),
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "gift_animations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stars_gifts" (
    "id" TEXT NOT NULL,
    "fromUserId" TEXT NOT NULL,
    "toUserId" TEXT NOT NULL,
    "starsAmount" BIGINT NOT NULL,
    "animationId" TEXT,
    "message" VARCHAR(255),
    "status" "GiftStatus" NOT NULL DEFAULT 'PENDING',
    "isUpgradedToNft" BOOLEAN NOT NULL DEFAULT false,
    "nftId" TEXT,
    "claimedAt" TIMESTAMP(3),
    "rejectedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "stars_gifts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "paid_reactions" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "starsAmount" BIGINT NOT NULL,
    "emoji" TEXT NOT NULL,
    "isAnonymous" BOOLEAN NOT NULL DEFAULT false,
    "ownerUserId" TEXT NOT NULL,
    "platformFee" BIGINT NOT NULL,
    "ownerEarned" BIGINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "paid_reactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reaction_leaderboards" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "totalStars" BIGINT NOT NULL,
    "reactionCount" INTEGER NOT NULL DEFAULT 1,
    "lastReactedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reaction_leaderboards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "message_tips" (
    "id" TEXT NOT NULL,
    "fromUserId" TEXT NOT NULL,
    "toUserId" TEXT NOT NULL,
    "messageId" TEXT,
    "chatId" TEXT,
    "starsAmount" BIGINT NOT NULL,
    "message" VARCHAR(200),
    "isAnonymous" BOOLEAN NOT NULL DEFAULT false,
    "platformFee" BIGINT NOT NULL,
    "creatorEarned" BIGINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "message_tips_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "revenue_settlements" (
    "id" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "grossAmount" BIGINT NOT NULL,
    "platformFee" BIGINT NOT NULL,
    "netAmount" BIGINT NOT NULL,
    "status" "SettlementStatus" NOT NULL DEFAULT 'PENDING',
    "settledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "revenue_settlements_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "gift_animations_name_key" ON "gift_animations"("name");

-- CreateIndex
CREATE INDEX "stars_gifts_fromUserId_idx" ON "stars_gifts"("fromUserId");

-- CreateIndex
CREATE INDEX "stars_gifts_toUserId_idx" ON "stars_gifts"("toUserId");

-- CreateIndex
CREATE INDEX "stars_gifts_status_idx" ON "stars_gifts"("status");

-- CreateIndex
CREATE INDEX "stars_gifts_expiresAt_idx" ON "stars_gifts"("expiresAt");

-- CreateIndex
CREATE INDEX "paid_reactions_messageId_chatId_idx" ON "paid_reactions"("messageId", "chatId");

-- CreateIndex
CREATE INDEX "paid_reactions_userId_idx" ON "paid_reactions"("userId");

-- CreateIndex
CREATE INDEX "paid_reactions_ownerUserId_idx" ON "paid_reactions"("ownerUserId");

-- CreateIndex
CREATE INDEX "paid_reactions_chatId_idx" ON "paid_reactions"("chatId");

-- CreateIndex
CREATE INDEX "reaction_leaderboards_entityId_entityType_totalStars_idx" ON "reaction_leaderboards"("entityId", "entityType", "totalStars");

-- CreateIndex
CREATE UNIQUE INDEX "reaction_leaderboards_entityId_entityType_userId_key" ON "reaction_leaderboards"("entityId", "entityType", "userId");

-- CreateIndex
CREATE INDEX "message_tips_fromUserId_idx" ON "message_tips"("fromUserId");

-- CreateIndex
CREATE INDEX "message_tips_toUserId_idx" ON "message_tips"("toUserId");

-- CreateIndex
CREATE INDEX "message_tips_messageId_idx" ON "message_tips"("messageId");

-- CreateIndex
CREATE INDEX "revenue_settlements_creatorId_idx" ON "revenue_settlements"("creatorId");

-- CreateIndex
CREATE INDEX "revenue_settlements_status_idx" ON "revenue_settlements"("status");

-- CreateIndex
CREATE INDEX "revenue_settlements_createdAt_idx" ON "revenue_settlements"("createdAt");

-- AddForeignKey
ALTER TABLE "stars_gifts" ADD CONSTRAINT "stars_gifts_animationId_fkey" FOREIGN KEY ("animationId") REFERENCES "gift_animations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
