import { describe, it, expect, beforeEach, afterAll, jest } from "@jest/globals";

// Mock Redis
jest.mock("../lib/redis", () => ({
  redis: {
    get: async () => null,
    set: async () => "OK",
    del: async () => 1,
    ping: async () => "PONG",
  },
}));

import { prisma } from "../lib/prisma";
import { StarsWalletService } from "../services/stars/StarsWalletService";
import { StarsReconciliationService } from "../services/stars/StarsReconciliationService";

const walletService = new StarsWalletService();
const reconciliationService = new StarsReconciliationService();

const USER_A = "test-stars-user-a";
const USER_B = "test-stars-user-b";

// ─────────────────────────────────────────
// Cleanup helper
// ─────────────────────────────────────────
async function cleanupTestUsers() {
  const wallets = await prisma.starsWallet.findMany({
    where: { userId: { in: [USER_A, USER_B] } },
  });
  const walletIds = wallets.map((w) => w.id);

  // Find all transactions for these wallets to clean up their ledger entries
  const transactions = await prisma.starsTransaction.findMany({
    where: { walletId: { in: walletIds } },
    select: { id: true },
  });
  const txIds = transactions.map((t) => t.id);

  // 1. Delete Ledger Entries first (FK to Transaction)
  await prisma.starsLedgerEntry.deleteMany({
    where: { transactionId: { in: txIds } },
  });

  // 2. Delete Transactions (FK to Wallet)
  await prisma.starsTransaction.deleteMany({
    where: { id: { in: txIds } },
  });

  // 3. Delete Locks (FK to Wallet)
  await prisma.starsLock.deleteMany({
    where: { walletId: { in: walletIds } },
  });

  // 4. Delete Wallets
  await prisma.starsWallet.deleteMany({
    where: { id: { in: walletIds } },
  });
}

describe("StarsWalletService", () => {
  beforeEach(async () => {
    await cleanupTestUsers();
  });

  afterAll(async () => {
    await cleanupTestUsers();
    await prisma.$disconnect();
  });

  // ───────────────────────────────────────
  describe("getBalance()", () => {
    it("should create wallet and return zero balance for new user", async () => {
      const balance = await walletService.getBalance(USER_A);
      expect(balance.available).toBe(BigInt(0));
      expect(balance.locked).toBe(BigInt(0));
      expect(balance.lifetimeEarned).toBe(BigInt(0));
    });
  });

  // ───────────────────────────────────────
  describe("creditStars()", () => {
    it("should credit stars to wallet", async () => {
      const result = await walletService.creditStars(
        USER_A,
        BigInt(100),
        "PURCHASE" as any,
        { description: "Test credit" }
      );

      expect(result.amount).toBe(BigInt(100));
      expect(result.newBalance).toBe(BigInt(100));

      const balance = await walletService.getBalance(USER_A);
      expect(balance.available).toBe(BigInt(100));
      expect(balance.lifetimeEarned).toBe(BigInt(100));
    });

    it("should reject zero credit amount", async () => {
      await expect(
        walletService.creditStars(USER_A, BigInt(0), "PURCHASE" as any)
      ).rejects.toThrow("Credit amount must be positive");
    });
  });

  // ───────────────────────────────────────
  describe("debitStars()", () => {
    it("should debit stars from wallet", async () => {
      await walletService.creditStars(USER_A, BigInt(500), "PURCHASE" as any);
      const result = await walletService.debitStars(
        USER_A,
        BigInt(200),
        "GIFT_SEND" as any
      );

      expect(result.amount).toBe(BigInt(200));
      expect(result.newBalance).toBe(BigInt(300));
    });

    it("should reject debit when insufficient balance", async () => {
      await walletService.creditStars(USER_A, BigInt(50), "PURCHASE" as any);

      await expect(
        walletService.debitStars(USER_A, BigInt(100), "GIFT_SEND" as any)
      ).rejects.toThrow("Insufficient stars balance");
    });
  });

  // ───────────────────────────────────────
  describe("transferStars()", () => {
    it("should transfer stars between users atomically", async () => {
      await walletService.creditStars(USER_A, BigInt(1000), "PURCHASE" as any);
      await walletService.creditStars(USER_B, BigInt(100), "PURCHASE" as any);

      const result = await walletService.transferStars(
        USER_A,
        USER_B,
        BigInt(300)
      );

      expect(result.fromBalance).toBe(BigInt(700));
      expect(result.toBalance).toBe(BigInt(400));

      const balanceA = await walletService.getBalance(USER_A);
      const balanceB = await walletService.getBalance(USER_B);
      expect(balanceA.available).toBe(BigInt(700));
      expect(balanceB.available).toBe(BigInt(400));
    });

    it("should reject self-transfer", async () => {
      await walletService.creditStars(USER_A, BigInt(100), "PURCHASE" as any);
      await expect(
        walletService.transferStars(USER_A, USER_A, BigInt(100))
      ).rejects.toThrow("Cannot transfer stars to yourself");
    });
  });

  // ───────────────────────────────────────
  describe("lockStars() & unlockStars()", () => {
    it("should lock stars and move to locked balance", async () => {
      await walletService.creditStars(USER_A, BigInt(500), "PURCHASE" as any);

      const lockId = await walletService.lockStars(
        USER_A,
        BigInt(200),
        "auction_bid",
        "auction-123"
      );

      const balance = await walletService.getBalance(USER_A);
      expect(balance.available).toBe(BigInt(300));
      expect(balance.locked).toBe(BigInt(200));

      // Unlock
      await walletService.unlockStars(lockId);

      const balanceAfter = await walletService.getBalance(USER_A);
      expect(balanceAfter.available).toBe(BigInt(500));
      expect(balanceAfter.locked).toBe(BigInt(0));
    });
  });

  // ───────────────────────────────────────
  describe("Ledger Reconciliation", () => {
    it("should pass reconciliation after credits and debits", async () => {
      await walletService.creditStars(USER_A, BigInt(1000), "PURCHASE" as any);
      await walletService.creditStars(USER_B, BigInt(500), "PURCHASE" as any);
      await walletService.transferStars(USER_A, USER_B, BigInt(200));

      const aCheck = await reconciliationService.verifyUserWalletBalance(USER_A);
      const bCheck = await reconciliationService.verifyUserWalletBalance(USER_B);

      expect(aCheck.isValid).toBe(true);
      expect(bCheck.isValid).toBe(true);
    });
  });
});
