import { describe, it, expect, beforeEach, afterAll } from "@jest/globals";
import { CreatorProfileService } from "../services/creator/CreatorProfileService";
import { PayoutMethodService } from "../services/creator/PayoutMethodService";
import { WithdrawalService } from "../services/creator/WithdrawalService";
import { StarsWalletService } from "../services/stars/StarsWalletService";
import { prisma } from "../lib/prisma";
const profileService = new CreatorProfileService();
const payoutMethodService = new PayoutMethodService();
const withdrawalService = new WithdrawalService();
const walletService = new StarsWalletService();

const TEST_USER = "test-creator-user-1";

async function seedExchangeRate() {
  await prisma.starsExchangeRate.upsert({
    where: { id: "default-rate" },
    update: { isActive: true, starsPerUsd: 50 },
    create: {
      id: "default-rate",
      starsPerUsd: 50,
      usdPerStar: 0.02,
      isActive: true,
      effectiveFrom: new Date(),
    },
  });
}

async function cleanupTestData() {
  const profile = await prisma.creatorProfile.findUnique({
    where: { userId: TEST_USER },
  });
  if (profile) {
    await prisma.creatorAnalyticsSnapshot.deleteMany({
      where: { creatorId: profile.id },
    });
    await prisma.creatorEarning.deleteMany({
      where: { creatorId: profile.id },
    });
    await prisma.creatorPayout.deleteMany({
      where: { creatorId: profile.id },
    });
    await prisma.creatorPayoutMethod.deleteMany({
      where: { creatorId: profile.id },
    });
    await prisma.creatorTaxInfo.deleteMany({
      where: { creatorId: profile.id },
    });
    await prisma.creatorProfile.delete({ where: { id: profile.id } });
  }

  const wallet = await prisma.starsWallet.findUnique({
    where: { userId: TEST_USER },
    include: { transactions: { select: { id: true } } }
  });

  if (wallet) {
    const txIds = wallet.transactions.map(tx => tx.id);
    
    // 1. Delete all ledger entries for these transactions
    await prisma.starsLedgerEntry.deleteMany({
      where: { transactionId: { in: txIds } },
    });

    // 2. Delete any other ledger entries for this user (just in case)
    await prisma.starsLedgerEntry.deleteMany({
      where: { accountId: TEST_USER },
    });

    // 3. Delete transactions
    await prisma.starsTransaction.deleteMany({
      where: { walletId: wallet.id },
    });

    // 4. Delete locks
    await prisma.starsLock.deleteMany({
      where: { walletId: wallet.id },
    });

    // 5. Delete wallet
    await prisma.starsWallet.delete({ where: { id: wallet.id } });
  }
}

// ─────────────────────────────────────────
describe("Day 4 — Creator Monetization & Withdrawals", () => {
  beforeEach(async () => {
    await cleanupTestData();
    await seedExchangeRate();
    await walletService.creditStars(
      TEST_USER,
      BigInt(100000),
      "PURCHASE" as any
    );
  });

  afterAll(async () => {
    await cleanupTestData();
    await prisma.$disconnect();
  });

  // ─────────────────────────────────────
  describe("CreatorProfileService", () => {
    it("should create creator profile on first access", async () => {
      const profile = await profileService.getOrCreateProfile(TEST_USER);
      expect(profile.userId).toBe(TEST_USER);
      expect(profile.isMonetizationEnabled).toBe(false);
      expect(profile.totalEarned).toBe(BigInt(0));
    });

    it("should update creator profile", async () => {
      await profileService.getOrCreateProfile(TEST_USER);
      await profileService.updateProfile(TEST_USER, {
        displayName: "Test Creator",
        bio: "Creating amazing content",
        category: "entertainment",
      });

      const updated = await profileService.getOrCreateProfile(TEST_USER);
      expect(updated.displayName).toBe("Test Creator");
      expect(updated.bio).toBe("Creating amazing content");
    });

    it("should record earning and update balances", async () => {
      const profile = await profileService.getOrCreateProfile(TEST_USER);

      await profileService.recordEarning(
        TEST_USER,
        "PAID_REACTION",
        "reaction-123",
        BigInt(1000),
        30,
        BigInt(300),
        BigInt(700)
      );

      const updated = await prisma.creatorProfile.findUnique({
        where: { userId: TEST_USER },
      });
      expect(updated?.totalEarned).toBe(BigInt(700));
      expect(updated?.pendingBalance).toBe(BigInt(700));
    });

    it("should get dashboard stats with correct period breakdown", async () => {
      await profileService.getOrCreateProfile(TEST_USER);

      await profileService.recordEarning(
        TEST_USER, "PAID_REACTION", "r-1",
        BigInt(500), 30, BigInt(150), BigInt(350)
      );
      await profileService.recordEarning(
        TEST_USER, "MESSAGE_TIP", "t-1",
        BigInt(300), 15, BigInt(45), BigInt(255)
      );

      const stats = await profileService.getDashboardStats(TEST_USER);
      expect(stats.totalEarned).toBe(BigInt(605));
      expect(stats.todayEarned).toBe(BigInt(605));
      expect(stats.earningsBySource["PAID_REACTION"]).toBe(BigInt(350));
      expect(stats.earningsBySource["MESSAGE_TIP"]).toBe(BigInt(255));
    });
  });

  // ─────────────────────────────────────
  describe("PayoutMethodService", () => {
    it("should add TON wallet payout method", async () => {
      await profileService.getOrCreateProfile(TEST_USER);

      const methodId = await payoutMethodService.addPayoutMethod(TEST_USER, {
        type: "TON_WALLET",
        tonAddress: "EQD4FPq-PRDieyQKkizFTRtSDyucUIqrj0v_zXJmqaDp6978",
        isDefault: true,
      });

      expect(methodId).toBeDefined();

      const methods = await payoutMethodService.getPayoutMethods(TEST_USER);
      expect(methods).toHaveLength(1);
      expect(methods[0].isDefault).toBe(true);
    });

    it("should reject invalid TON address", async () => {
      await profileService.getOrCreateProfile(TEST_USER);

      await expect(
        payoutMethodService.addPayoutMethod(TEST_USER, {
          type: "TON_WALLET",
          tonAddress: "invalid_address",
        })
      ).rejects.toThrow(/Invalid TON wallet address format/);
    });
  });

  // ─────────────────────────────────────
  describe("WithdrawalService", () => {
    it("should request withdrawal successfully", async () => {
      // Setup
      await profileService.getOrCreateProfile(TEST_USER);
      await profileService.updateProfile(TEST_USER, {
        displayName: "Test Creator",
      });
      await profileService.recordEarning(
        TEST_USER, "PAID_REACTION", "r-test",
        BigInt(5000), 30, BigInt(1500), BigInt(3500)
      );
      // Move to available
      await prisma.creatorProfile.update({
        where: { userId: TEST_USER },
        data: {
          availableBalance: BigInt(3500),
          pendingBalance: BigInt(0),
          isMonetizationEnabled: true,
        },
      });

      const methodId = await payoutMethodService.addPayoutMethod(TEST_USER, {
        type: "TON_WALLET",
        tonAddress: "EQD4FPq-PRDieyQKkizFTRtSDyucUIqrj0v_zXJmqaDp6978",
        isDefault: true,
      });

      const result = await withdrawalService.requestWithdrawal(
        TEST_USER,
        BigInt(2000),
        methodId
      );

      expect(result.payoutId).toBeDefined();
      expect(result.starsAmount).toBe(BigInt(2000));
      expect(result.platformFee).toBe(BigInt(100)); // 5%
      expect(result.netStars).toBe(BigInt(1900));
      expect(result.estimatedFiatAmount).toBeCloseTo(38, 0); // 1900/50
    });

    it("should reject withdrawal below minimum", async () => {
      await profileService.getOrCreateProfile(TEST_USER);
      await prisma.creatorProfile.update({
        where: { userId: TEST_USER },
        data: {
          availableBalance: BigInt(100000),
          isMonetizationEnabled: true,
        },
      });

      const methodId = await payoutMethodService.addPayoutMethod(TEST_USER, {
        type: "TON_WALLET",
        tonAddress: "EQD4FPq-PRDieyQKkizFTRtSDyucUIqrj0v_zXJmqaDp6978",
      });

      await expect(
        withdrawalService.requestWithdrawal(TEST_USER, BigInt(100), methodId)
      ).rejects.toThrow(/Minimum withdrawal is/);
    });

    it("should cancel pending withdrawal and restore balance", async () => {
      await profileService.getOrCreateProfile(TEST_USER);
      await prisma.creatorProfile.update({
        where: { userId: TEST_USER },
        data: {
          availableBalance: BigInt(10000),
          isMonetizationEnabled: true,
        },
      });

      const methodId = await payoutMethodService.addPayoutMethod(TEST_USER, {
        type: "TON_WALLET",
        tonAddress: "EQD4FPq-PRDieyQKkizFTRtSDyucUIqrj0v_zXJmqaDp6978",
      });

      const { payoutId } = await withdrawalService.requestWithdrawal(
        TEST_USER,
        BigInt(2000),
        methodId
      );

      await withdrawalService.cancelWithdrawal(TEST_USER, payoutId);

      const profile = await prisma.creatorProfile.findUnique({
        where: { userId: TEST_USER },
      });
      expect(profile?.availableBalance).toBe(BigInt(10000));
    });
  });
});
