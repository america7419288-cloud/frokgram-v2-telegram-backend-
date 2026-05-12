import { describe, it, expect, beforeEach, afterAll } from "@jest/globals";
import { StarsGiftService } from "../services/stars/StarsGiftService";
import { PaidReactionService } from "../services/stars/PaidReactionService";
import { MessageTipService } from "../services/stars/MessageTipService";
import { StarsWalletService } from "../services/stars/StarsWalletService";
import { prisma } from "../lib/prisma";

const giftService = new StarsGiftService();
const reactionService = new PaidReactionService();
const tipService = new MessageTipService();
const walletService = new StarsWalletService();

const USER_A = "test-day3-user-a";
const USER_B = "test-day3-user-b";
const USER_C = "test-day3-user-c";

async function cleanupTestData() {
  const userIds = [USER_A, USER_B, USER_C];

  // 1. Delete dependent social records
  await prisma.messageTip.deleteMany({
    where: { OR: [{ fromUserId: { in: userIds } }, { toUserId: { in: userIds } }] }
  });
  await prisma.paidReaction.deleteMany({
    where: { userId: { in: userIds } }
  });
  await prisma.reactionLeaderboard.deleteMany({
    where: { userId: { in: userIds } }
  });
  await prisma.starsGift.deleteMany({
    where: { OR: [{ fromUserId: { in: userIds } }, { toUserId: { in: userIds } }] }
  });
  await prisma.revenueSettlement.deleteMany({
    where: { creatorId: { in: userIds } }
  });

  // 2. Delete financial records in reverse dependency order
  // Find all transaction IDs first to delete ALL ledger entries (including system side)
  const transactions = await prisma.starsTransaction.findMany({
    where: { wallet: { userId: { in: userIds } } },
    select: { id: true }
  });
  const txIds = transactions.map(t => t.id);

  await prisma.starsLedgerEntry.deleteMany({
    where: { transactionId: { in: txIds } }
  });

  await prisma.starsTransaction.deleteMany({
    where: { id: { in: txIds } }
  });
  
  await prisma.starsLock.deleteMany({
    where: { userId: { in: userIds } }
  });

  // 3. Finally delete the wallets
  await prisma.starsWallet.deleteMany({
    where: { userId: { in: userIds } }
  });
}

// ─────────────────────────────────────────
describe("Day 3 — Gifts, Reactions & Tips", () => {
  beforeEach(async () => {
    await cleanupTestData();

    // Fund test users
    await walletService.creditStars(USER_A, BigInt(10000), "PURCHASE" as any);
    await walletService.creditStars(USER_B, BigInt(5000), "PURCHASE" as any);
  });

  afterAll(async () => {
    await cleanupTestData();
    await prisma.$disconnect();
  });

  // ─────────────────────────────────────
  describe("StarsGiftService", () => {
    it("should send a gift and lock sender stars", async () => {
      const result = await giftService.sendGift({
        fromUserId: USER_A,
        toUserId: USER_B,
        starsAmount: BigInt(500),
      });

      expect(result.giftId).toBeDefined();
      expect(result.expiresAt).toBeInstanceOf(Date);

      const balance = await walletService.getBalance(USER_A);
      expect(balance.available).toBe(BigInt(9500));
      expect(balance.locked).toBe(BigInt(500));
    });

    it("should claim gift and credit recipient", async () => {
      const { giftId } = await giftService.sendGift({
        fromUserId: USER_A,
        toUserId: USER_B,
        starsAmount: BigInt(300),
      });

      const claimResult = await giftService.claimGift(USER_B, giftId);
      expect(claimResult.starsReceived).toBe(BigInt(300));

      const balanceA = await walletService.getBalance(USER_A);
      const balanceB = await walletService.getBalance(USER_B);
      expect(balanceA.locked).toBe(BigInt(0));
      expect(balanceB.available).toBe(BigInt(5300));
    });

    it("should reject gift and return stars to sender", async () => {
      const { giftId } = await giftService.sendGift({
        fromUserId: USER_A,
        toUserId: USER_B,
        starsAmount: BigInt(200),
      });

      await giftService.rejectGift(USER_B, giftId);

      const balanceA = await walletService.getBalance(USER_A);
      expect(balanceA.available).toBe(BigInt(10000));
      expect(balanceA.locked).toBe(BigInt(0));
    });

    it("should prevent self-gifting", async () => {
      await expect(
        giftService.sendGift({
          fromUserId: USER_A,
          toUserId: USER_A,
          starsAmount: BigInt(100),
        })
      ).rejects.toThrow("Cannot send a gift to yourself");
    });

    it("should not allow claiming another user gift", async () => {
      const { giftId } = await giftService.sendGift({
        fromUserId: USER_A,
        toUserId: USER_B,
        starsAmount: BigInt(100),
      });

      await expect(
        giftService.claimGift(USER_C, giftId)
      ).rejects.toThrow("This gift is not for you");
    });
  });

  // ─────────────────────────────────────
  describe("PaidReactionService", () => {
    it("should send paid reaction and update leaderboard", async () => {
      const result = await reactionService.sendPaidReaction(
        USER_A,
        "chat-123",
        "msg-456",
        "🔥",
        BigInt(100),
        USER_B
      );

      expect(result.reactionId).toBeDefined();
      expect(result.starsSpent).toBe(BigInt(100));
      expect(result.newLeaderboardPosition).toBe(1);

      const balance = await walletService.getBalance(USER_A);
      expect(balance.available).toBe(BigInt(9900));
    });

    it("should return correct leaderboard", async () => {
      await reactionService.sendPaidReaction(
        USER_A, "chat-123", "msg-789", "❤️", BigInt(500), USER_B
      );
      await reactionService.sendPaidReaction(
        USER_B, "chat-123", "msg-789", "⭐", BigInt(100), USER_C
      );

      const leaderboard = await reactionService.getLeaderboard(
        "msg-789",
        "message"
      );

      expect(leaderboard[0].userId).toBe(USER_A);
      expect(leaderboard[0].totalStars).toBe("500");
      expect(leaderboard[1].userId).toBe(USER_B);
    });

    it("should prevent self reaction", async () => {
      await expect(
        reactionService.sendPaidReaction(
          USER_A, "chat-123", "msg-999", "❤️", BigInt(50), USER_A
        )
      ).rejects.toThrow("Cannot send paid reaction on your own message");
    });
  });

  // ─────────────────────────────────────
  describe("MessageTipService", () => {
    it("should send tip with correct fee split", async () => {
      const result = await tipService.tipMessage(
        USER_A,
        USER_B,
        BigInt(1000),
        { messageId: "msg-tip-test" }
      );

      expect(result.starsSpent).toBe(BigInt(1000));
      // 15% platform fee
      expect(result.creatorEarned).toBe(BigInt(850));

      const balanceA = await walletService.getBalance(USER_A);
      expect(balanceA.available).toBe(BigInt(9000));
    });

    it("should get message earnings correctly", async () => {
      await tipService.tipMessage(USER_A, USER_B, BigInt(500), {
        messageId: "msg-earnings-test",
      });

      // USER_B tipping themselves is not allowed in logic, so tip USER_C
      await tipService.tipMessage(USER_A, USER_C, BigInt(200), {
        messageId: "msg-earnings-test",
      });

      const earnings = await tipService.getMessageEarnings("msg-earnings-test");
      expect(earnings.uniqueTippers).toBeGreaterThan(0);
      expect(earnings.totalStars).toBe(BigInt(700));
    });
  });
});
