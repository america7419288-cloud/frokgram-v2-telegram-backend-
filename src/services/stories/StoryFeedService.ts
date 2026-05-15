import { StoryStatus, StoryPrivacy } from "@prisma/client";
import { redis } from "../../lib/redis";
import { prisma } from "../../lib/prisma";

// ─────────────────────────────────────────
// Types
// ─────────────────────────────────────────
export interface StoryRing {
  userId: string;
  displayName: string;
  avatarUrl: string | null;
  hasUnviewed: boolean;
  latestStoryAt: Date;
  storyCount: number;
  isCloseFriend: boolean;
}

// ─────────────────────────────────────────
// Story Feed Service
// Builds ordered list of "story rings"
// (circles you see at top of chat list)
// ─────────────────────────────────────────
export class StoryFeedService {

  // ─────────────────────────────────────
  // GET STORY FEED
  // Returns ordered story rings for user
  // Order: close friends first, then unseen, then seen
  // ─────────────────────────────────────
  async getStoryFeed(
    userId: string,
    cursor?: string,
    limit: number = 20
  ): Promise<{
    rings: StoryRing[];
    nextCursor: string | null;
    total: number;
  }> {
    // Check cache first
    const cacheKey = `story:feed:${userId}`;
    const cached = await redis.get(cacheKey);
    if (cached && !cursor) {
      return JSON.parse(cached);
    }

    // Get users that this user follows / has in contacts
    // (Simplified: in real implementation, query contact/follow table)
    const contactUserIds = await this.getContactUserIds(userId);

    if (contactUserIds.length === 0) {
      return { rings: [], nextCursor: null, total: 0 };
    }

    // Get close friends list
    const closeFriends = await prisma.closeFriend.findMany({
      where: { userId },
      select: { friendId: true },
    });
    const closeFriendIds = new Set(closeFriends.map((f) => f.friendId));

    // Get active stories from contacts
    const now = new Date();
    const activeStories = await prisma.story.findMany({
      where: {
        userId: { in: contactUserIds },
        isDeleted: false,
        isArchived: false,
        status: StoryStatus.ACTIVE,
        expiresAt: { gt: now },
        OR: [
          { privacyType: StoryPrivacy.EVERYONE },
          { privacyType: StoryPrivacy.CONTACTS },
          {
            privacyType: StoryPrivacy.CLOSE_FRIENDS,
            userId: { in: Array.from(closeFriendIds) },
          },
        ],
      },
      select: {
        id: true,
        userId: true,
        createdAt: true,
        expiresAt: true,
        thumbnailUrl: true,
        views: {
          where: { viewerId: userId },
          select: { viewedAt: true },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    // Group stories by user → build rings
    const ringMap = new Map<string, {
      storyCount: number;
      hasUnviewed: boolean;
      latestStoryAt: Date;
    }>();

    for (const story of activeStories) {
      const existing = ringMap.get(story.userId);
      const isViewed = story.views.length > 0;

      if (!existing) {
        ringMap.set(story.userId, {
          storyCount: 1,
          hasUnviewed: !isViewed,
          latestStoryAt: story.createdAt,
        });
      } else {
        existing.storyCount++;
        if (!isViewed) existing.hasUnviewed = true;
        if (story.createdAt > existing.latestStoryAt) {
          existing.latestStoryAt = story.createdAt;
        }
      }
    }

    // TODO: fetch user display names & avatars from user service
    // For now, using placeholder data
    const rings: StoryRing[] = Array.from(ringMap.entries())
      .map(([ringUserId, data]) => ({
        userId: ringUserId,
        displayName: `User ${ringUserId.slice(0, 8)}`,
        avatarUrl: null,
        hasUnviewed: data.hasUnviewed,
        latestStoryAt: data.latestStoryAt,
        storyCount: data.storyCount,
        isCloseFriend: closeFriendIds.has(ringUserId),
      }))
      .sort((a, b) => {
        // Sort order:
        // 1. Close friends with unviewed
        // 2. Others with unviewed
        // 3. Close friends viewed
        // 4. Others viewed
        const aScore =
          (a.isCloseFriend ? 100 : 0) + (a.hasUnviewed ? 50 : 0);
        const bScore =
          (b.isCloseFriend ? 100 : 0) + (b.hasUnviewed ? 50 : 0);

        if (aScore !== bScore) return bScore - aScore;
        return b.latestStoryAt.getTime() - a.latestStoryAt.getTime();
      });

    // Apply cursor pagination
    const cursorIndex = cursor
      ? rings.findIndex((r) => r.userId === cursor)
      : -1;
    const startIndex = cursorIndex >= 0 ? cursorIndex + 1 : 0;
    const pageRings = rings.slice(startIndex, startIndex + limit);
    const nextCursor =
      startIndex + limit < rings.length
        ? pageRings[pageRings.length - 1]?.userId ?? null
        : null;

    const result = {
      rings: pageRings,
      nextCursor,
      total: rings.length,
    };

    // Cache feed for 60 seconds
    if (!cursor) {
      await redis.setex(cacheKey, 60, JSON.stringify(result));
    }

    return result;
  }

  // ─────────────────────────────────────
  // ADD CLOSE FRIEND
  // ─────────────────────────────────────
  async addCloseFriend(userId: string, friendId: string): Promise<void> {
    if (userId === friendId) return;

    await prisma.closeFriend.upsert({
      where: { userId_friendId: { userId, friendId } },
      update: {},
      create: { userId, friendId },
    });

    await redis.del(`story:feed:${userId}`);
  }

  // ─────────────────────────────────────
  // REMOVE CLOSE FRIEND
  // ─────────────────────────────────────
  async removeCloseFriend(userId: string, friendId: string): Promise<void> {
    await prisma.closeFriend.deleteMany({
      where: { userId, friendId },
    });

    await redis.del(`story:feed:${userId}`);
  }

  // ─────────────────────────────────────
  // GET CLOSE FRIENDS LIST
  // ─────────────────────────────────────
  async getCloseFriends(userId: string) {
    return prisma.closeFriend.findMany({
      where: { userId },
      orderBy: { addedAt: "desc" },
    });
  }

  // ─────────────────────────────────────
  // PRIVATE: Get contact user IDs
  // In real app: query your contacts/follows table
  // ─────────────────────────────────────
  private async getContactUserIds(userId: string): Promise<string[]> {
    // TODO: Replace with actual contacts/following query
    // For now returns empty (will be implemented with user system)
    return [];
  }
}

export const storyFeedService = new StoryFeedService();
