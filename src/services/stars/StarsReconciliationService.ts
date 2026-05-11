import { LedgerEntryType } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { AppError } from "../../lib/errors";

// ─────────────────────────────────────────
// Reconciliation Service
// Verifies ledger is balanced
// Run daily to catch any inconsistencies
// ─────────────────────────────────────────
export class StarsReconciliationService {

  // ─────────────────────────────────────
  // VERIFY LEDGER BALANCE
  // Sum of all debits must equal sum of all credits
  // This is the golden rule of double-entry bookkeeping
  // ─────────────────────────────────────
  async verifyLedgerBalance(): Promise<{
    isBalanced: boolean;
    totalDebits: bigint;
    totalCredits: bigint;
    difference: bigint;
  }> {
    const [debits, credits] = await Promise.all([
      prisma.starsLedgerEntry.aggregate({
        where: { entryType: LedgerEntryType.DEBIT },
        _sum: { amount: true },
      }),
      prisma.starsLedgerEntry.aggregate({
        where: { entryType: LedgerEntryType.CREDIT },
        _sum: { amount: true },
      }),
    ]);

    const totalDebits = debits._sum.amount ?? BigInt(0);
    const totalCredits = credits._sum.amount ?? BigInt(0);
    const difference = totalDebits - totalCredits;
    const isBalanced = difference === BigInt(0);

    return { isBalanced, totalDebits, totalCredits, difference };
  }

  // ─────────────────────────────────────
  // VERIFY USER WALLET BALANCE
  // Check wallet balance matches ledger
  // ─────────────────────────────────────
  async verifyUserWalletBalance(userId: string): Promise<{
    isValid: boolean;
    walletBalance: bigint;
    ledgerBalance: bigint;
    discrepancy: bigint;
  }> {
    const wallet = await prisma.starsWallet.findUnique({
      where: { userId },
    });

    if (!wallet) {
      throw new AppError("WALLET_NOT_FOUND", "Wallet not found", 404);
    }

    // Calculate balance from ledger
    const [credits, debits] = await Promise.all([
      prisma.starsLedgerEntry.aggregate({
        where: {
          accountId: userId,
          entryType: LedgerEntryType.CREDIT,
        },
        _sum: { amount: true },
      }),
      prisma.starsLedgerEntry.aggregate({
        where: {
          accountId: userId,
          entryType: LedgerEntryType.DEBIT,
        },
        _sum: { amount: true },
      }),
    ]);

    const ledgerBalance =
      (credits._sum.amount ?? BigInt(0)) -
      (debits._sum.amount ?? BigInt(0));

    const discrepancy = wallet.balance - ledgerBalance;
    const isValid = discrepancy === BigInt(0);

    if (!isValid) {
      await this.logDiscrepancy(userId, wallet.balance, ledgerBalance, discrepancy);
    }

    return {
      isValid,
      walletBalance: wallet.balance,
      ledgerBalance,
      discrepancy,
    };
  }

  // ─────────────────────────────────────
  // DAILY RECONCILIATION
  // Run this as a cron job every night
  // ─────────────────────────────────────
  async runDailyReconciliation(): Promise<{
    ledgerBalanced: boolean;
    usersChecked: number;
    discrepanciesFound: number;
    report: any;
  }> {
    console.log("🔍 Starting daily Stars reconciliation...");

    const ledgerCheck = await this.verifyLedgerBalance();

    // Check all wallets with activity in last 24h
    const activeWallets = await prisma.starsWallet.findMany({
      where: {
        updatedAt: {
          gte: new Date(Date.now() - 24 * 60 * 60 * 1000),
        },
      },
      select: { userId: true },
    });

    let discrepanciesFound = 0;
    const discrepancies: any[] = [];

    for (const w of activeWallets) {
      const check = await this.verifyUserWalletBalance(w.userId);
      if (!check.isValid) {
        discrepanciesFound++;
        discrepancies.push({
          userId: w.userId,
          discrepancy: check.discrepancy.toString(),
        });
      }
    }

    const report = {
      date: new Date().toISOString(),
      ledgerBalanced: ledgerCheck.isBalanced,
      totalDebits: ledgerCheck.totalDebits.toString(),
      totalCredits: ledgerCheck.totalCredits.toString(),
      ledgerDifference: ledgerCheck.difference.toString(),
      walletsChecked: activeWallets.length,
      discrepanciesFound,
      discrepancies,
    };

    console.log("📊 Reconciliation report:", report);
    return {
      ledgerBalanced: ledgerCheck.isBalanced,
      usersChecked: activeWallets.length,
      discrepanciesFound,
      report,
    };
  }

  private async logDiscrepancy(
    userId: string,
    walletBalance: bigint,
    ledgerBalance: bigint,
    discrepancy: bigint
  ): Promise<void> {
    console.error("⚠️ WALLET DISCREPANCY DETECTED", {
      userId,
      walletBalance: walletBalance.toString(),
      ledgerBalance: ledgerBalance.toString(),
      discrepancy: discrepancy.toString(),
      timestamp: new Date().toISOString(),
    });
    // In production: alert the on-call engineer immediately
  }
}

export const starsReconciliationService = new StarsReconciliationService();
