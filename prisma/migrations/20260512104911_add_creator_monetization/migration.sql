-- CreateEnum
CREATE TYPE "PayoutMethodType" AS ENUM ('TON_WALLET', 'BANK_TRANSFER', 'PAYPAL', 'STRIPE', 'USDT_TRC20', 'USDT_ERC20');

-- CreateEnum
CREATE TYPE "EarningSourceType" AS ENUM ('PAID_REACTION', 'MESSAGE_TIP', 'CHANNEL_SUBSCRIPTION', 'GATED_CONTENT', 'PAID_STORY', 'NFT_SALE', 'NFT_ROYALTY', 'BOT_PAYMENT', 'AD_REVENUE', 'REFERRAL_BONUS');

-- CreateEnum
CREATE TYPE "PayoutStatus" AS ENUM ('PENDING', 'APPROVED', 'PROCESSING', 'COMPLETED', 'FAILED', 'CANCELLED', 'ON_HOLD');

-- CreateTable
CREATE TABLE "creator_profiles" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "displayName" TEXT,
    "bio" VARCHAR(500),
    "category" TEXT,
    "isVerified" BOOLEAN NOT NULL DEFAULT false,
    "isMonetizationEnabled" BOOLEAN NOT NULL DEFAULT false,
    "totalEarned" BIGINT NOT NULL DEFAULT 0,
    "totalWithdrawn" BIGINT NOT NULL DEFAULT 0,
    "pendingBalance" BIGINT NOT NULL DEFAULT 0,
    "availableBalance" BIGINT NOT NULL DEFAULT 0,
    "subscriberCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "creator_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "creator_payout_methods" (
    "id" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "type" "PayoutMethodType" NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "isVerified" BOOLEAN NOT NULL DEFAULT false,
    "tonAddress" TEXT,
    "bankAccountName" TEXT,
    "bankAccountNum" TEXT,
    "bankRoutingNum" TEXT,
    "bankName" TEXT,
    "bankCountry" TEXT,
    "paypalEmail" TEXT,
    "externalId" TEXT,
    "minPayoutStars" BIGINT NOT NULL DEFAULT 1000,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "creator_payout_methods_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "creator_earnings" (
    "id" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "sourceType" "EarningSourceType" NOT NULL,
    "sourceId" TEXT NOT NULL,
    "grossAmount" BIGINT NOT NULL,
    "platformFeeRate" INTEGER NOT NULL,
    "platformFee" BIGINT NOT NULL,
    "netAmount" BIGINT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'STARS',
    "period" TEXT NOT NULL,
    "settledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "creator_earnings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "creator_payouts" (
    "id" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "payoutMethodId" TEXT NOT NULL,
    "starsAmount" BIGINT NOT NULL,
    "fiatAmount" DECIMAL(12,4),
    "fiatCurrency" TEXT DEFAULT 'USD',
    "exchangeRate" DECIMAL(12,6),
    "platformFee" BIGINT NOT NULL DEFAULT 0,
    "netStars" BIGINT NOT NULL,
    "status" "PayoutStatus" NOT NULL DEFAULT 'PENDING',
    "failureReason" TEXT,
    "providerTxId" TEXT,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "metadata" JSONB,

    CONSTRAINT "creator_payouts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "creator_tax_info" (
    "id" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "taxFormType" TEXT,
    "taxId" TEXT,
    "fullLegalName" TEXT,
    "address" TEXT,
    "country" TEXT,
    "isSubmitted" BOOLEAN NOT NULL DEFAULT false,
    "isVerified" BOOLEAN NOT NULL DEFAULT false,
    "submittedAt" TIMESTAMP(3),
    "verifiedAt" TIMESTAMP(3),

    CONSTRAINT "creator_tax_info_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "creator_analytics_snapshots" (
    "id" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "periodType" TEXT NOT NULL,
    "totalEarned" BIGINT NOT NULL DEFAULT 0,
    "reactionEarned" BIGINT NOT NULL DEFAULT 0,
    "tipEarned" BIGINT NOT NULL DEFAULT 0,
    "subEarned" BIGINT NOT NULL DEFAULT 0,
    "storyEarned" BIGINT NOT NULL DEFAULT 0,
    "nftEarned" BIGINT NOT NULL DEFAULT 0,
    "adEarned" BIGINT NOT NULL DEFAULT 0,
    "newSubscribers" INTEGER NOT NULL DEFAULT 0,
    "lostSubscribers" INTEGER NOT NULL DEFAULT 0,
    "totalReactions" INTEGER NOT NULL DEFAULT 0,
    "totalTips" INTEGER NOT NULL DEFAULT 0,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "creator_analytics_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stars_exchange_rates" (
    "id" TEXT NOT NULL,
    "starsPerUsd" DECIMAL(12,6) NOT NULL,
    "usdPerStar" DECIMAL(12,8) NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "effectiveFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "effectiveTo" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stars_exchange_rates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "compliance_flags" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "flagType" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "isResolved" BOOLEAN NOT NULL DEFAULT false,
    "resolvedBy" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "compliance_flags_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "creator_profiles_userId_key" ON "creator_profiles"("userId");

-- CreateIndex
CREATE INDEX "creator_profiles_userId_idx" ON "creator_profiles"("userId");

-- CreateIndex
CREATE INDEX "creator_profiles_isMonetizationEnabled_idx" ON "creator_profiles"("isMonetizationEnabled");

-- CreateIndex
CREATE INDEX "creator_payout_methods_creatorId_idx" ON "creator_payout_methods"("creatorId");

-- CreateIndex
CREATE INDEX "creator_earnings_creatorId_idx" ON "creator_earnings"("creatorId");

-- CreateIndex
CREATE INDEX "creator_earnings_creatorId_period_idx" ON "creator_earnings"("creatorId", "period");

-- CreateIndex
CREATE INDEX "creator_earnings_sourceType_idx" ON "creator_earnings"("sourceType");

-- CreateIndex
CREATE INDEX "creator_earnings_createdAt_idx" ON "creator_earnings"("createdAt");

-- CreateIndex
CREATE INDEX "creator_payouts_creatorId_idx" ON "creator_payouts"("creatorId");

-- CreateIndex
CREATE INDEX "creator_payouts_status_idx" ON "creator_payouts"("status");

-- CreateIndex
CREATE INDEX "creator_payouts_requestedAt_idx" ON "creator_payouts"("requestedAt");

-- CreateIndex
CREATE UNIQUE INDEX "creator_tax_info_creatorId_key" ON "creator_tax_info"("creatorId");

-- CreateIndex
CREATE INDEX "creator_analytics_snapshots_creatorId_periodType_idx" ON "creator_analytics_snapshots"("creatorId", "periodType");

-- CreateIndex
CREATE UNIQUE INDEX "creator_analytics_snapshots_creatorId_period_periodType_key" ON "creator_analytics_snapshots"("creatorId", "period", "periodType");

-- CreateIndex
CREATE INDEX "stars_exchange_rates_isActive_idx" ON "stars_exchange_rates"("isActive");

-- CreateIndex
CREATE INDEX "stars_exchange_rates_effectiveFrom_idx" ON "stars_exchange_rates"("effectiveFrom");

-- CreateIndex
CREATE INDEX "compliance_flags_userId_idx" ON "compliance_flags"("userId");

-- CreateIndex
CREATE INDEX "compliance_flags_isResolved_idx" ON "compliance_flags"("isResolved");

-- CreateIndex
CREATE INDEX "compliance_flags_severity_idx" ON "compliance_flags"("severity");

-- AddForeignKey
ALTER TABLE "creator_payout_methods" ADD CONSTRAINT "creator_payout_methods_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "creator_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "creator_earnings" ADD CONSTRAINT "creator_earnings_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "creator_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "creator_payouts" ADD CONSTRAINT "creator_payouts_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "creator_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "creator_payouts" ADD CONSTRAINT "creator_payouts_payoutMethodId_fkey" FOREIGN KEY ("payoutMethodId") REFERENCES "creator_payout_methods"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "creator_tax_info" ADD CONSTRAINT "creator_tax_info_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "creator_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "creator_analytics_snapshots" ADD CONSTRAINT "creator_analytics_snapshots_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "creator_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
