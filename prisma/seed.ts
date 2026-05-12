import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function seedStarsPriceTiers() {
  console.log("🌟 Seeding Stars price tiers...");

  const tiers = [
    {
      starsCount: BigInt(50),
      priceUsd: 0.99,
      discountPercent: 0,
      bonusStars: BigInt(0),
      isPopular: false,
      isBestValue: false,
      sortOrder: 1,
      appleProductId: "stars_50",
      googleProductId: "stars_50",
    },
    {
      starsCount: BigInt(100),
      priceUsd: 1.99,
      discountPercent: 0,
      bonusStars: BigInt(0),
      isPopular: false,
      isBestValue: false,
      sortOrder: 2,
      appleProductId: "stars_100",
      googleProductId: "stars_100",
    },
    {
      starsCount: BigInt(500),
      priceUsd: 7.99,
      discountPercent: 20,
      bonusStars: BigInt(25),
      isPopular: true,
      isBestValue: false,
      sortOrder: 3,
      appleProductId: "stars_500",
      googleProductId: "stars_500",
    },
    {
      starsCount: BigInt(1000),
      priceUsd: 14.99,
      discountPercent: 25,
      bonusStars: BigInt(75),
      isPopular: false,
      isBestValue: false,
      sortOrder: 4,
      appleProductId: "stars_1000",
      googleProductId: "stars_1000",
    },
    {
      starsCount: BigInt(2500),
      priceUsd: 34.99,
      discountPercent: 30,
      bonusStars: BigInt(250),
      isPopular: false,
      isBestValue: true,
      sortOrder: 5,
      appleProductId: "stars_2500",
      googleProductId: "stars_2500",
    },
    {
      starsCount: BigInt(5000),
      priceUsd: 64.99,
      discountPercent: 35,
      bonusStars: BigInt(750),
      isPopular: false,
      isBestValue: false,
      sortOrder: 6,
      appleProductId: "stars_5000",
      googleProductId: "stars_5000",
    },
    {
      starsCount: BigInt(10000),
      priceUsd: 119.99,
      discountPercent: 40,
      bonusStars: BigInt(2000),
      isPopular: false,
      isBestValue: false,
      sortOrder: 7,
      appleProductId: "stars_10000",
      googleProductId: "stars_10000",
    },
  ];

  for (const tier of tiers) {
    await prisma.starsPriceTier.upsert({
      where: { id: `tier_${tier.starsCount}` }, // Using a pseudo-id for idempotency in seed
      update: tier,
      create: { ...tier, id: `tier_${tier.starsCount}` },
    });
  }

  // ── Seed System Accounts ────────────────
  const systemAccounts = [
    { accountKey: "PURCHASE_POOL",    description: "Stars purchased with real money" },
    { accountKey: "FEE_POOL",         description: "Platform fees collected" },
    { accountKey: "CREATOR_EARNINGS", description: "Pending creator payouts" },
    { accountKey: "GIFT_ESCROW",      description: "Stars held for pending gifts" },
    { accountKey: "AUCTION_ESCROW",   description: "Stars locked in active bids" },
    { accountKey: "PROMO_POOL",       description: "Promotional stars budget" },
  ];

  for (const account of systemAccounts) {
    await prisma.systemAccount.upsert({
      where: { accountKey: account.accountKey as any },
      update: {},
      create: { ...account, balance: BigInt(0) },
    });
  }

  console.log("✅ Stars price tiers and system accounts seeded");
}

async function seedGiftAnimations() {
  console.log("🎁 Seeding gift animations...");

  const animations = [
    // Common gifts
    {
      name: "heart",
      displayName: "Heart",
      lottieUrl: "/animations/gifts/heart.json",
      thumbnailUrl: "/thumbnails/gifts/heart.png",
      category: "classic",
      rarity: "COMMON" as const,
      priceStars: BigInt(50),
      sortOrder: 1,
    },
    {
      name: "star",
      displayName: "Shooting Star",
      lottieUrl: "/animations/gifts/star.json",
      thumbnailUrl: "/thumbnails/gifts/star.png",
      category: "classic",
      rarity: "COMMON" as const,
      priceStars: BigInt(50),
      sortOrder: 2,
    },
    {
      name: "cake",
      displayName: "Birthday Cake",
      lottieUrl: "/animations/gifts/cake.json",
      thumbnailUrl: "/thumbnails/gifts/cake.png",
      category: "classic",
      rarity: "COMMON" as const,
      priceStars: BigInt(75),
      sortOrder: 3,
    },
    // Uncommon gifts
    {
      name: "diamond",
      displayName: "Diamond",
      lottieUrl: "/animations/gifts/diamond.json",
      thumbnailUrl: "/thumbnails/gifts/diamond.png",
      category: "premium",
      rarity: "UNCOMMON" as const,
      priceStars: BigInt(150),
      sortOrder: 4,
    },
    {
      name: "trophy",
      displayName: "Golden Trophy",
      lottieUrl: "/animations/gifts/trophy.json",
      thumbnailUrl: "/thumbnails/gifts/trophy.png",
      category: "premium",
      rarity: "UNCOMMON" as const,
      priceStars: BigInt(200),
      sortOrder: 5,
    },
    // Rare gifts
    {
      name: "rocket",
      displayName: "Rocket",
      lottieUrl: "/animations/gifts/rocket.json",
      thumbnailUrl: "/thumbnails/gifts/rocket.png",
      category: "rare",
      rarity: "RARE" as const,
      priceStars: BigInt(500),
      sortOrder: 6,
    },
    {
      name: "crown",
      displayName: "Royal Crown",
      lottieUrl: "/animations/gifts/crown.json",
      thumbnailUrl: "/thumbnails/gifts/crown.png",
      category: "rare",
      rarity: "RARE" as const,
      priceStars: BigInt(750),
      sortOrder: 7,
    },
    // Epic gifts
    {
      name: "dragon",
      displayName: "Dragon",
      lottieUrl: "/animations/gifts/dragon.json",
      thumbnailUrl: "/thumbnails/gifts/dragon.png",
      category: "epic",
      rarity: "EPIC" as const,
      priceStars: BigInt(2000),
      sortOrder: 8,
    },
    // Legendary gifts
    {
      name: "universe",
      displayName: "Universe",
      lottieUrl: "/animations/gifts/universe.json",
      thumbnailUrl: "/thumbnails/gifts/universe.png",
      category: "legendary",
      rarity: "LEGENDARY" as const,
      priceStars: BigInt(10000),
      isLimited: true,
      sortOrder: 9,
    },
  ];

  for (const animation of animations) {
    await prisma.giftAnimation.upsert({
      where: { name: animation.name },
      update: {},
      create: { ...animation, isAvailable: true },
    });
  }

  console.log("✅ Gift animations seeded");
}

async function main() {
  console.log("Seeding database...");
  await seedStarsPriceTiers();
  await seedGiftAnimations();
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });
