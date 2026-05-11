import { prisma } from "../lib/prisma";
import { redis } from "../lib/redis";
import { AppError } from "../lib/errors";

/**
 * Get user premium status
 */
export const getUserPremiumStatus = async (userId: string) => {
  // Try to get from cache first
  const cacheKey = `user:premium:${userId}`;
  const cached = await redis.get(cacheKey);
  
  if (cached) {
    return JSON.parse(cached);
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      isPremium: true,
      premiumUntil: true,
      subscriptionPlan: true,
    },
  });

  if (!user) {
    throw new AppError("NOT_FOUND", "User not found", 404);
  }

  // Cache for 1 hour
  await redis.set(cacheKey, JSON.stringify(user), "EX", 3600);

  return user;
};

/**
 * Process a premium purchase
 */
export const processPurchase = async (
  userId: string,
  planId: string,
  paymentMethod: string
) => {
  // Simplified logic for simulation
  const durationInDays = planId === "yearly" ? 365 : 30;
  const expiryDate = new Date();
  expiryDate.setDate(expiryDate.getDate() + durationInDays);

  const updatedUser = await prisma.user.update({
    where: { id: userId },
    data: {
      isPremium: true,
      premiumUntil: expiryDate,
      subscriptionPlan: planId,
    },
  });

  // Invalidate cache
  await redis.del(`user:premium:${userId}`);

  return {
    success: true,
    message: "Premium subscription activated",
    expiryDate: updatedUser.premiumUntil,
  };
};
