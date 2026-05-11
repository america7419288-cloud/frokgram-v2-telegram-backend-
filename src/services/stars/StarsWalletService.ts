import {
  StarsTransactionType,
  StarsTransactionStatus,
  LedgerEntryType,
  LedgerAccountType,
  Prisma,
} from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { redis } from "../../lib/redis";
import { AppError } from "../../lib/errors";
import { EventBus } from "../../lib/eventBus";

// ─────────────────────────────────────────
// Types
// ─────────────────────────────────────────
export interface WalletBalance {
  available: bigint;
  locked: bigint;
  total: bigint;         // available + locked
  lifetimeEarned: bigint;
  lifetimeSpent: bigint;
}

export interface TransferResult {
  transactionId: string;
  fromBalance: bigint;
  toBalance: bigint;
  amount: bigint;
  completedAt: Date;
}

export interface CreditResult {
  transactionId: string;
  newBalance: bigint;
  amount: bigint;
}

export interface DebitResult {
  transactionId: string;
  newBalance: bigint;
  amount: bigint;
}

// ─────────────────────────────────────────
// Cache Keys
// ─────────────────────────────────────────
const WalletCacheKeys = {
  balance: (userId: string) => `stars:balance:${userId}`,
  wallet: (userId: string) => `stars:wallet:${userId}`,
  priceTiers: () => `stars:price_tiers`,
} as const;

const BALANCE_CACHE_TTL = 30; // 30 seconds — short TTL for financial data

// ─────────────────────────────────────────
// Stars Wallet Service
// ─────────────────────────────────────────
export class StarsWalletService {

  // ─────────────────────────────────────
  // GET OR CREATE WALLET
  // Every user gets a wallet on first access
  // ─────────────────────────────────────
  async getOrCreateWallet(userId: string) {
    const existing = await prisma.starsWallet.findUnique({
      where: { userId },
    });

    if (existing) return existing;

    // Create wallet + ledger entry atomically
    const wallet = await prisma.$transaction(async (tx) => {
      const newWallet = await tx.starsWallet.create({
        data: {
          userId,
          balance: BigInt(0),
          lockedBalance: BigInt(0),
          lifetimeEarned: BigInt(0),
          lifetimeSpent: BigInt(0),
        },
      });

      await EventBus.emit("stars.wallet_created", { userId });
      return newWallet;
    });

    return wallet;
  }

  // ─────────────────────────────────────
  // GET BALANCE
  // ─────────────────────────────────────
  async getBalance(userId: string): Promise<WalletBalance> {
    // Try cache first
    const cached = await redis.get(WalletCacheKeys.balance(userId));
    if (cached) {
      const parsed = JSON.parse(cached);
      return {
        available: BigInt(parsed.available),
        locked: BigInt(parsed.locked),
        total: BigInt(parsed.total),
        lifetimeEarned: BigInt(parsed.lifetimeEarned),
        lifetimeSpent: BigInt(parsed.lifetimeSpent),
      };
    }

    const wallet = await this.getOrCreateWallet(userId);

    const balance: WalletBalance = {
      available: wallet.balance,
      locked: wallet.lockedBalance,
      total: wallet.balance + wallet.lockedBalance,
      lifetimeEarned: wallet.lifetimeEarned,
      lifetimeSpent: wallet.lifetimeSpent,
    };

    // Cache with short TTL (financial data needs to be fresh)
    await redis.set(
      WalletCacheKeys.balance(userId),
      JSON.stringify({
        available: balance.available.toString(),
        locked: balance.locked.toString(),
        total: balance.total.toString(),
        lifetimeEarned: balance.lifetimeEarned.toString(),
        lifetimeSpent: balance.lifetimeSpent.toString(),
      }),
      "EX",
      BALANCE_CACHE_TTL
    );

    return balance;
  }

  // ─────────────────────────────────────
  // CREDIT STARS
  // Add stars to a user's wallet
  // Used for: purchases, refunds, gifts claimed, promo
  // ─────────────────────────────────────
  async creditStars(
    userId: string,
    amount: bigint,
    type: StarsTransactionType,
    options: {
      fromUserId?: string;
      referenceId?: string;
      referenceType?: string;
      description?: string;
      metadata?: Record<string, any>;
    } = {}
  ): Promise<CreditResult> {
    if (amount <= BigInt(0)) {
      throw new AppError("INVALID_AMOUNT", "Credit amount must be positive", 400);
    }

    const wallet = await this.getOrCreateWallet(userId);

    const result = await prisma.$transaction(async (tx) => {
      // 1. Update wallet balance
      const updatedWallet = await tx.starsWallet.update({
        where: { id: wallet.id },
        data: {
          balance: { increment: amount },
          lifetimeEarned: { increment: amount },
        },
      });

      // 2. Create transaction record
      const transaction = await tx.starsTransaction.create({
        data: {
          walletId: wallet.id,
          fromUserId: options.fromUserId ?? null,
          toUserId: userId,
          amount,
          type,
          status: StarsTransactionStatus.COMPLETED,
          referenceId: options.referenceId ?? null,
          referenceType: options.referenceType ?? null,
          description: options.description ?? null,
          metadata: options.metadata ? (options.metadata as Prisma.InputJsonValue) : Prisma.JsonNull,
          completedAt: new Date(),
        },
      });

      // 3. Double-entry ledger
      await this.createLedgerEntries(tx, transaction.id, [
        {
          // CREDIT user account
          accountId: userId,
          accountType: LedgerAccountType.USER,
          entryType: LedgerEntryType.CREDIT,
          amount,
          balanceAfter: updatedWallet.balance,
        },
        {
          // DEBIT source (purchase pool or another user)
          accountId: options.fromUserId ?? "SYSTEM_PURCHASE_POOL",
          accountType: options.fromUserId
            ? LedgerAccountType.USER
            : LedgerAccountType.SYSTEM_PURCHASE_POOL,
          entryType: LedgerEntryType.DEBIT,
          amount,
          balanceAfter: BigInt(0), // system account balance tracked separately
        },
      ]);

      return { transaction, newBalance: updatedWallet.balance };
    });

    // Invalidate balance cache
    await redis.del(WalletCacheKeys.balance(userId));

    await EventBus.emit("stars.credited", {
      userId,
      amount: amount.toString(),
      type,
      transactionId: result.transaction.id,
    });

    return {
      transactionId: result.transaction.id,
      newBalance: result.newBalance,
      amount,
    };
  }

  // ─────────────────────────────────────
  // DEBIT STARS
  // Remove stars from a user's wallet
  // Used for: spending, fees, gifts sent
  // ─────────────────────────────────────
  async debitStars(
    userId: string,
    amount: bigint,
    type: StarsTransactionType,
    options: {
      toUserId?: string;
      referenceId?: string;
      referenceType?: string;
      description?: string;
      metadata?: Record<string, any>;
      skipBalanceCheck?: boolean; // for admin adjustments
    } = {}
  ): Promise<DebitResult> {
    if (amount <= BigInt(0)) {
      throw new AppError("INVALID_AMOUNT", "Debit amount must be positive", 400);
    }

    const wallet = await this.getOrCreateWallet(userId);

    // Check sufficient balance
    if (!options.skipBalanceCheck && wallet.balance < amount) {
      throw new AppError(
        "INSUFFICIENT_STARS",
        `Insufficient stars balance. Required: ${amount}, Available: ${wallet.balance}`,
        402
      );
    }

    const result = await prisma.$transaction(async (tx) => {
      // 1. Update wallet
      const updatedWallet = await tx.starsWallet.update({
        where: { id: wallet.id },
        data: {
          balance: { decrement: amount },
          lifetimeSpent: { increment: amount },
        },
      });

      // 2. Create transaction
      const transaction = await tx.starsTransaction.create({
        data: {
          walletId: wallet.id,
          fromUserId: userId,
          toUserId: options.toUserId ?? null,
          amount,
          type,
          status: StarsTransactionStatus.COMPLETED,
          referenceId: options.referenceId ?? null,
          referenceType: options.referenceType ?? null,
          description: options.description ?? null,
          metadata: options.metadata ? (options.metadata as Prisma.InputJsonValue) : Prisma.JsonNull,
          completedAt: new Date(),
        },
      });

      // 3. Double-entry ledger
      await this.createLedgerEntries(tx, transaction.id, [
        {
          // DEBIT user account (stars leaving)
          accountId: userId,
          accountType: LedgerAccountType.USER,
          entryType: LedgerEntryType.DEBIT,
          amount,
          balanceAfter: updatedWallet.balance,
        },
        {
          // CREDIT destination
          accountId: options.toUserId ?? "SYSTEM_FEE_POOL",
          accountType: options.toUserId
            ? LedgerAccountType.USER
            : LedgerAccountType.SYSTEM_FEE_POOL,
          entryType: LedgerEntryType.CREDIT,
          amount,
          balanceAfter: BigInt(0),
        },
      ]);

      return { transaction, newBalance: updatedWallet.balance };
    });

    // Invalidate cache
    await redis.del(WalletCacheKeys.balance(userId));

    await EventBus.emit("stars.debited", {
      userId,
      amount: amount.toString(),
      type,
      transactionId: result.transaction.id,
    });

    return {
      transactionId: result.transaction.id,
      newBalance: result.newBalance,
      amount,
    };
  }

  // ─────────────────────────────────────
  // TRANSFER STARS (user to user)
  // Atomic — both debit and credit happen
  // or neither happens (transaction rollback)
  // ─────────────────────────────────────
  async transferStars(
    fromUserId: string,
    toUserId: string,
    amount: bigint,
    options: {
      type?: StarsTransactionType;
      referenceId?: string;
      referenceType?: string;
      description?: string;
      metadata?: Record<string, any>;
    } = {}
  ): Promise<TransferResult> {
    if (amount <= BigInt(0)) {
      throw new AppError("INVALID_AMOUNT", "Transfer amount must be positive", 400);
    }

    if (fromUserId === toUserId) {
      throw new AppError("SELF_TRANSFER", "Cannot transfer stars to yourself", 400);
    }

    // Check minimum transfer
    if (amount < BigInt(1)) {
      throw new AppError("BELOW_MINIMUM", "Minimum transfer is 1 star", 400);
    }

    const [fromWallet, toWallet] = await Promise.all([
      this.getOrCreateWallet(fromUserId),
      this.getOrCreateWallet(toUserId),
    ]);

    // Check balance
    if (fromWallet.balance < amount) {
      throw new AppError(
        "INSUFFICIENT_STARS",
        "Insufficient stars for transfer",
        402
      );
    }

    const type = options.type ?? StarsTransactionType.TRANSFER;

    const result = await prisma.$transaction(async (tx) => {
      // 1. Debit sender
      const updatedSenderWallet = await tx.starsWallet.update({
        where: { id: fromWallet.id },
        data: {
          balance: { decrement: amount },
          lifetimeSpent: { increment: amount },
        },
      });

      // 2. Credit receiver
      const updatedReceiverWallet = await tx.starsWallet.update({
        where: { id: toWallet.id },
        data: {
          balance: { increment: amount },
          lifetimeEarned: { increment: amount },
        },
      });

      // 3. Create transaction (one record covers the full transfer)
      const transaction = await tx.starsTransaction.create({
        data: {
          walletId: fromWallet.id,
          fromUserId,
          toUserId,
          amount,
          type,
          status: StarsTransactionStatus.COMPLETED,
          referenceId: options.referenceId ?? null,
          referenceType: options.referenceType ?? null,
          description: options.description ?? null,
          metadata: options.metadata ? (options.metadata as Prisma.InputJsonValue) : Prisma.JsonNull,
          completedAt: new Date(),
        },
      });

      // 4. Double-entry ledger
      await this.createLedgerEntries(tx, transaction.id, [
        {
          accountId: fromUserId,
          accountType: LedgerAccountType.USER,
          entryType: LedgerEntryType.DEBIT,
          amount,
          balanceAfter: updatedSenderWallet.balance,
        },
        {
          accountId: toUserId,
          accountType: LedgerAccountType.USER,
          entryType: LedgerEntryType.CREDIT,
          amount,
          balanceAfter: updatedReceiverWallet.balance,
        },
      ]);

      return {
        transaction,
        fromBalance: updatedSenderWallet.balance,
        toBalance: updatedReceiverWallet.balance,
      };
    });

    // Invalidate both users' caches
    await Promise.all([
      redis.del(WalletCacheKeys.balance(fromUserId)),
      redis.del(WalletCacheKeys.balance(toUserId)),
    ]);

    await EventBus.emit("stars.transferred", {
      fromUserId,
      toUserId,
      amount: amount.toString(),
      transactionId: result.transaction.id,
    });

    return {
      transactionId: result.transaction.id,
      fromBalance: result.fromBalance,
      toBalance: result.toBalance,
      amount,
      completedAt: result.transaction.completedAt!,
    };
  }

  // ─────────────────────────────────────
  // LOCK STARS
  // Reserve stars for a pending operation
  // Stars move from balance → lockedBalance
  // ─────────────────────────────────────
  async lockStars(
    userId: string,
    amount: bigint,
    reason: string,
    referenceId?: string,
    expiryMinutes: number = 60
  ): Promise<string> {
    const wallet = await this.getOrCreateWallet(userId);

    if (wallet.balance < amount) {
      throw new AppError(
        "INSUFFICIENT_STARS",
        "Insufficient stars to lock",
        402
      );
    }

    const expiresAt = new Date(
      Date.now() + expiryMinutes * 60 * 1000
    );

    const lock = await prisma.$transaction(async (tx) => {
      // Move stars from balance to locked
      await tx.starsWallet.update({
        where: { id: wallet.id },
        data: {
          balance: { decrement: amount },
          lockedBalance: { increment: amount },
        },
      });

      // Create lock record
      const newLock = await tx.starsLock.create({
        data: {
          walletId: wallet.id,
          userId,
          amount,
          reason,
          referenceId: referenceId ?? null,
          expiresAt,
          isReleased: false,
        },
      });

      return newLock;
    });

    // Invalidate cache
    await redis.del(WalletCacheKeys.balance(userId));

    return lock.id;
  }

  // ─────────────────────────────────────
  // UNLOCK STARS (cancel/release lock)
  // Stars move back from lockedBalance → balance
  // ─────────────────────────────────────
  async unlockStars(lockId: string): Promise<void> {
    const lock = await prisma.starsLock.findUnique({
      where: { id: lockId },
      include: { wallet: true },
    });

    if (!lock) {
      throw new AppError("NOT_FOUND", "Stars lock not found", 404);
    }

    if (lock.isReleased) {
      throw new AppError("CONFLICT", "Stars lock already released", 409);
    }

    await prisma.$transaction(async (tx) => {
      // Move stars back to available
      await tx.starsWallet.update({
        where: { id: lock.walletId },
        data: {
          balance: { increment: lock.amount },
          lockedBalance: { decrement: lock.amount },
        },
      });

      // Mark lock as released
      await tx.starsLock.update({
        where: { id: lockId },
        data: { isReleased: true, releasedAt: new Date() },
      });
    });

    await redis.del(WalletCacheKeys.balance(lock.userId));
  }

  // ─────────────────────────────────────
  // COMMIT LOCKED STARS
  // Finalize a lock — transfer locked stars to recipient
  // Stars move from lockedBalance → gone (and recipient gets credited)
  // ─────────────────────────────────────
  async commitLockedStars(
    lockId: string,
    toUserId: string,
    type: StarsTransactionType,
    options: {
      referenceId?: string;
      referenceType?: string;
      description?: string;
      platformFeePercent?: number; // 0-100
    } = {}
  ): Promise<{
    transactionId: string;
    totalAmount: bigint;
    platformFee: bigint;
    netAmount: bigint;
  }> {
    const lock = await prisma.starsLock.findUnique({
      where: { id: lockId },
      include: { wallet: true },
    });

    if (!lock) throw new AppError("NOT_FOUND", "Stars lock not found", 404);
    if (lock.isReleased) throw new AppError("CONFLICT", "Already released", 409);

    const feePercent = options.platformFeePercent ?? 30;
    const platformFee = (lock.amount * BigInt(feePercent)) / BigInt(100);
    const netAmount = lock.amount - platformFee;

    const toWallet = await this.getOrCreateWallet(toUserId);

    const result = await prisma.$transaction(async (tx) => {
      // 1. Remove from sender's locked balance
      await tx.starsWallet.update({
        where: { id: lock.walletId },
        data: {
          lockedBalance: { decrement: lock.amount },
          lifetimeSpent: { increment: lock.amount },
        },
      });

      // 2. Credit net amount to recipient
      const updatedToWallet = await tx.starsWallet.update({
        where: { id: toWallet.id },
        data: {
          balance: { increment: netAmount },
          lifetimeEarned: { increment: netAmount },
        },
      });

      // 3. Mark lock as released
      await tx.starsLock.update({
        where: { id: lockId },
        data: { isReleased: true, releasedAt: new Date() },
      });

      // 4. Create transaction
      const transaction = await tx.starsTransaction.create({
        data: {
          walletId: lock.walletId,
          fromUserId: lock.userId,
          toUserId,
          amount: lock.amount,
          type,
          status: StarsTransactionStatus.COMPLETED,
          referenceId: options.referenceId ?? null,
          referenceType: options.referenceType ?? null,
          description: options.description ?? null,
          metadata: { platformFee: platformFee.toString(), netAmount: netAmount.toString() },
          completedAt: new Date(),
        },
      });

      // 5. Ledger entries
      await this.createLedgerEntries(tx, transaction.id, [
        {
          accountId: lock.userId,
          accountType: LedgerAccountType.USER,
          entryType: LedgerEntryType.DEBIT,
          amount: lock.amount,
          balanceAfter: lock.wallet.balance, // balance was already deducted when locked
        },
        {
          accountId: toUserId,
          accountType: LedgerAccountType.USER,
          entryType: LedgerEntryType.CREDIT,
          amount: netAmount,
          balanceAfter: updatedToWallet.balance,
        },
        {
          accountId: "SYSTEM_FEE_POOL",
          accountType: LedgerAccountType.SYSTEM_FEE_POOL,
          entryType: LedgerEntryType.CREDIT,
          amount: platformFee,
          balanceAfter: BigInt(0),
        },
      ]);

      return { transaction, netAmount, platformFee };
    });

    // Invalidate caches
    await Promise.all([
      redis.del(WalletCacheKeys.balance(lock.userId)),
      redis.del(WalletCacheKeys.balance(toUserId)),
    ]);

    await EventBus.emit("stars.committed", {
      fromUserId: lock.userId,
      toUserId,
      totalAmount: lock.amount.toString(),
      platformFee: platformFee.toString(),
      netAmount: netAmount.toString(),
      transactionId: result.transaction.id,
    });

    return {
      transactionId: result.transaction.id,
      totalAmount: lock.amount,
      platformFee,
      netAmount,
    };
  }

  // ─────────────────────────────────────
  // GET TRANSACTION HISTORY
  // ─────────────────────────────────────
  async getTransactionHistory(
    userId: string,
    options: {
      page?: number;
      limit?: number;
      type?: StarsTransactionType;
      startDate?: Date;
      endDate?: Date;
    } = {}
  ) {
    const page = options.page ?? 1;
    const limit = Math.min(options.limit ?? 20, 100);
    const skip = (page - 1) * limit;

    const wallet = await this.getOrCreateWallet(userId);

    const where: any = {
      walletId: wallet.id,
      status: StarsTransactionStatus.COMPLETED,
    };

    if (options.type) where.type = options.type;
    if (options.startDate || options.endDate) {
      where.createdAt = {};
      if (options.startDate) where.createdAt.gte = options.startDate;
      if (options.endDate) where.createdAt.lte = options.endDate;
    }

    const [transactions, total] = await Promise.all([
      prisma.starsTransaction.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
      }),
      prisma.starsTransaction.count({ where }),
    ]);

    return {
      transactions,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
        hasMore: page * limit < total,
      },
    };
  }

  // ─────────────────────────────────────
  // GET PRICE TIERS
  // ─────────────────────────────────────
  async getPriceTiers() {
    const cached = await redis.get(WalletCacheKeys.priceTiers());
    if (cached) return JSON.parse(cached);

    const tiers = await prisma.starsPriceTier.findMany({
      where: { isActive: true },
      orderBy: { sortOrder: "asc" },
    });

    // Cache for 1 hour
    await redis.set(
      WalletCacheKeys.priceTiers(),
      JSON.stringify(
        tiers.map((t) => ({
          ...t,
          starsCount: t.starsCount.toString(),
          bonusStars: t.bonusStars.toString(),
          priceUsd: t.priceUsd.toString(),
        }))
      ),
      "EX",
      3600
    );

    return tiers;
  }

  // ─────────────────────────────────────
  // PRIVATE: Create Ledger Entries
  // ─────────────────────────────────────
  private async createLedgerEntries(
    tx: any,
    transactionId: string,
    entries: Array<{
      accountId: string;
      accountType: LedgerAccountType;
      entryType: LedgerEntryType;
      amount: bigint;
      balanceAfter: bigint;
    }>
  ): Promise<void> {
    await tx.starsLedgerEntry.createMany({
      data: entries.map((e) => ({
        transactionId,
        accountId: e.accountId,
        accountType: e.accountType,
        entryType: e.entryType,
        amount: e.amount,
        balanceAfter: e.balanceAfter,
      })),
    });
  }
}

export const starsWalletService = new StarsWalletService();
