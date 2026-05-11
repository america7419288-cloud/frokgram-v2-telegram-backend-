// src/lib/redis.ts
import Redis from "ioredis";
const redis = new Redis(process.env.REDIS_URL || "redis://localhost:6379");
export default redis;

// src/lib/errors.ts
export class AppError extends Error {
  constructor(public message: string, public statusCode: number = 500) {
    super(message);
  }
}

// src/lib/eventBus.ts
import { EventEmitter } from "events";
export const eventBus = new EventEmitter();
