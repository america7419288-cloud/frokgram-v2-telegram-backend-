-- CreateEnum
CREATE TYPE "LedgerAccountType" AS ENUM ('USER', 'SYSTEM_PURCHASE_POOL', 'SYSTEM_FEE_POOL', 'SYSTEM_CREATOR_EARNINGS', 'SYSTEM_GIFT_ESCROW', 'SYSTEM_AUCTION_ESCROW');

-- CreateEnum
CREATE TYPE "LedgerEntryType" AS ENUM ('DEBIT', 'CREDIT');

-- CreateEnum
CREATE TYPE "StarsTransactionType" AS ENUM ('PURCHASE', 'TRANSFER', 'GIFT_SEND', 'GIFT_CLAIM', 'GIFT_REFUND', 'REACTION', 'TIP', 'CHANNEL_SUB', 'BOT_PAYMENT', 'NFT_PURCHASE', 'NFT_SALE', 'WITHDRAWAL', 'PLATFORM_FEE', 'PROMO_CREDIT', 'REFUND', 'ADJUSTMENT');

-- CreateEnum
CREATE TYPE "StarsTransactionStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'REFUNDED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PurchaseOrderStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "SystemAccountKey" AS ENUM ('PURCHASE_POOL', 'FEE_POOL', 'CREATOR_EARNINGS', 'GIFT_ESCROW', 'AUCTION_ESCROW', 'PROMO_POOL');

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "premiumUntil" TIMESTAMP(3),
ADD COLUMN     "subscriptionPlan" TEXT;

-- CreateTable
CREATE TABLE "stars_wallets" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "balance" BIGINT NOT NULL DEFAULT 0,
    "lockedBalance" BIGINT NOT NULL DEFAULT 0,
    "lifetimeEarned" BIGINT NOT NULL DEFAULT 0,
    "lifetimeSpent" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "stars_wallets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stars_ledger_entries" (
    "id" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "accountType" "LedgerAccountType" NOT NULL,
    "entryType" "LedgerEntryType" NOT NULL,
    "amount" BIGINT NOT NULL,
    "balanceAfter" BIGINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stars_ledger_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stars_transactions" (
    "id" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "fromUserId" TEXT,
    "toUserId" TEXT,
    "amount" BIGINT NOT NULL,
    "type" "StarsTransactionType" NOT NULL,
    "status" "StarsTransactionStatus" NOT NULL DEFAULT 'PENDING',
    "referenceId" TEXT,
    "referenceType" TEXT,
    "description" TEXT,
    "metadata" JSONB,
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "stars_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stars_locks" (
    "id" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    "reason" TEXT NOT NULL,
    "referenceId" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "isReleased" BOOLEAN NOT NULL DEFAULT false,
    "releasedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stars_locks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stars_purchase_orders" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "starsAmount" BIGINT NOT NULL,
    "fiatAmount" DECIMAL(10,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "paymentProvider" TEXT NOT NULL,
    "providerOrderId" TEXT,
    "receiptData" TEXT,
    "status" "PurchaseOrderStatus" NOT NULL DEFAULT 'PENDING',
    "tierId" TEXT NOT NULL,
    "bonusStars" BIGINT NOT NULL DEFAULT 0,
    "failureReason" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "stars_purchase_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stars_price_tiers" (
    "id" TEXT NOT NULL,
    "starsCount" BIGINT NOT NULL,
    "priceUsd" DECIMAL(10,2) NOT NULL,
    "discountPercent" INTEGER NOT NULL DEFAULT 0,
    "bonusStars" BIGINT NOT NULL DEFAULT 0,
    "isPopular" BOOLEAN NOT NULL DEFAULT false,
    "isBestValue" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "appleProductId" TEXT,
    "googleProductId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stars_price_tiers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "system_accounts" (
    "id" TEXT NOT NULL,
    "accountKey" "SystemAccountKey" NOT NULL,
    "balance" BIGINT NOT NULL DEFAULT 0,
    "description" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "system_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "stars_wallets_userId_key" ON "stars_wallets"("userId");

-- CreateIndex
CREATE INDEX "stars_wallets_userId_idx" ON "stars_wallets"("userId");

-- CreateIndex
CREATE INDEX "stars_ledger_entries_transactionId_idx" ON "stars_ledger_entries"("transactionId");

-- CreateIndex
CREATE INDEX "stars_ledger_entries_accountId_idx" ON "stars_ledger_entries"("accountId");

-- CreateIndex
CREATE INDEX "stars_ledger_entries_createdAt_idx" ON "stars_ledger_entries"("createdAt");

-- CreateIndex
CREATE INDEX "stars_transactions_walletId_idx" ON "stars_transactions"("walletId");

-- CreateIndex
CREATE INDEX "stars_transactions_fromUserId_idx" ON "stars_transactions"("fromUserId");

-- CreateIndex
CREATE INDEX "stars_transactions_toUserId_idx" ON "stars_transactions"("toUserId");

-- CreateIndex
CREATE INDEX "stars_transactions_type_idx" ON "stars_transactions"("type");

-- CreateIndex
CREATE INDEX "stars_transactions_status_idx" ON "stars_transactions"("status");

-- CreateIndex
CREATE INDEX "stars_transactions_createdAt_idx" ON "stars_transactions"("createdAt");

-- CreateIndex
CREATE INDEX "stars_locks_walletId_idx" ON "stars_locks"("walletId");

-- CreateIndex
CREATE INDEX "stars_locks_userId_idx" ON "stars_locks"("userId");

-- CreateIndex
CREATE INDEX "stars_locks_expiresAt_idx" ON "stars_locks"("expiresAt");

-- CreateIndex
CREATE INDEX "stars_locks_isReleased_idx" ON "stars_locks"("isReleased");

-- CreateIndex
CREATE INDEX "stars_purchase_orders_userId_idx" ON "stars_purchase_orders"("userId");

-- CreateIndex
CREATE INDEX "stars_purchase_orders_providerOrderId_idx" ON "stars_purchase_orders"("providerOrderId");

-- CreateIndex
CREATE INDEX "stars_purchase_orders_status_idx" ON "stars_purchase_orders"("status");

-- CreateIndex
CREATE UNIQUE INDEX "system_accounts_accountKey_key" ON "system_accounts"("accountKey");

-- AddForeignKey
ALTER TABLE "stars_ledger_entries" ADD CONSTRAINT "stars_ledger_entries_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "stars_transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stars_transactions" ADD CONSTRAINT "stars_transactions_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "stars_wallets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stars_locks" ADD CONSTRAINT "stars_locks_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "stars_wallets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
