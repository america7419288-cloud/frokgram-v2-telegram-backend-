import { EventBus } from "../lib/eventBus";
import logger from "../lib/logger";

// ─────────────────────────────────────────
// Stars Event Listeners
// ─────────────────────────────────────────

// Reconciliation Failure
EventBus.on("stars.reconciliation_failed", (data: { 
  walletId: string, 
  actualBalance: bigint, 
  ledgerBalance: bigint,
  diff: bigint 
}) => {
  logger.error("🚨 STARS RECONCILIATION FAILED", {
    ...data,
    actualBalance: data.actualBalance.toString(),
    ledgerBalance: data.ledgerBalance.toString(),
    diff: data.diff.toString(),
  });
  
  // Here you could send a Sentry alert or an admin notification
});

// Large Transfers (Audit)
EventBus.on("stars.transfer_completed", (data: {
  fromUserId: string,
  toUserId: string,
  amount: bigint,
  transactionId: string
}) => {
  if (data.amount > BigInt(10000)) {
    logger.warn("💰 LARGE STARS TRANSFER DETECTED", {
      ...data,
      amount: data.amount.toString(),
    });
  }
});

// High Volume Purchases
EventBus.on("stars.purchase_completed", (data: {
  userId: string,
  amount: bigint,
  orderId: string
}) => {
  logger.info("✨ STARS PURCHASE COMPLETED", {
    ...data,
    amount: data.amount.toString(),
  });
});

// Suspicious Activity
EventBus.on("stars.suspicious_activity", (data: {
  userId: string,
  reason: string,
  metadata?: any
}) => {
  logger.warn("🕵️ SUSPICIOUS STARS ACTIVITY", data);
});
