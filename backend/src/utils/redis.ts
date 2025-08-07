// backend/src/utils/redis.ts
import Redis from "ioredis";
import { logger } from "./logger";
import { config } from "./config";

class RedisConnection {
  private static instance: RedisConnection;
  private client: Redis | null = null;
  private isConnected: boolean = false;

  private constructor() {}

  public static getInstance(): RedisConnection {
    if (!RedisConnection.instance) {
      RedisConnection.instance = new RedisConnection();
    }
    return RedisConnection.instance;
  }

  public async connect(): Promise<void> {
    if (this.isConnected && this.client) {
      logger.info("Redis already connected");
      return;
    }

    try {
      this.client = new Redis({
        host: config.redis.host,
        port: config.redis.port,
        password: config.redis.password,
        db: config.redis.db,
        retryDelayOnFailover: 100,
        maxRetriesPerRequest: 3,
        lazyConnect: true,
        keepAlive: 30000,
        connectionName: "attendance-system",
      });

      // Connection event handlers
      this.client.on("connect", () => {
        logger.info("Redis connection established");
        this.isConnected = true;
      });

      this.client.on("ready", () => {
        logger.info("Redis client ready");
      });

      this.client.on("error", (error) => {
        logger.error("Redis connection error:", error);
        this.isConnected = false;
      });

      this.client.on("close", () => {
        logger.warn("Redis connection closed");
        this.isConnected = false;
      });

      this.client.on("reconnecting", () => {
        logger.info("Redis reconnecting...");
      });

      // Establish connection
      await this.client.connect();

      // Test connection
      await this.client.ping();

      logger.info("Successfully connected to Redis", {
        host: config.redis.host,
        port: config.redis.port,
        db: config.redis.db,
      });
    } catch (error) {
      this.isConnected = false;
      logger.error("Failed to connect to Redis:", error);
      throw error;
    }
  }

  public async disconnect(): Promise<void> {
    if (!this.client) {
      return;
    }

    try {
      await this.client.quit();
      this.client = null;
      this.isConnected = false;
      logger.info("Redis connection closed");
    } catch (error) {
      logger.error("Error closing Redis connection:", error);
      throw error;
    }
  }

  public getClient(): Redis {
    if (!this.client || !this.isConnected) {
      throw new Error("Redis client not connected. Call connect() first.");
    }
    return this.client;
  }

  public isConnectionReady(): boolean {
    return this.isConnected && this.client !== null;
  }

  public async healthCheck(): Promise<{ status: string; details: any }> {
    try {
      if (!this.client || !this.isConnected) {
        return {
          status: "disconnected",
          details: { connected: false },
        };
      }

      const response = await this.client.ping();
      const info = await this.client.info("server");

      return {
        status: "healthy",
        details: {
          ping: response,
          connected: this.isConnected,
          serverInfo: {
            version: this.extractRedisVersion(info),
            uptime: this.extractUptime(info),
          },
        },
      };
    } catch (error) {
      return {
        status: "error",
        details: { error: (error as Error).message },
      };
    }
  }

  private extractRedisVersion(info: string): string {
    const match = info.match(/redis_version:(\S+)/);
    return match ? match[1] : "unknown";
  }

  private extractUptime(info: string): string {
    const match = info.match(/uptime_in_seconds:(\d+)/);
    if (match) {
      const seconds = parseInt(match[1]);
      const hours = Math.floor(seconds / 3600);
      const minutes = Math.floor((seconds % 3600) / 60);
      return `${hours}h ${minutes}m`;
    }
    return "unknown";
  }
}

// Cache service class for high-level operations
export class CacheService {
  private redis: Redis;

  constructor() {
    this.redis = redisConnection.getClient();
  }

  // Face descriptors cache
  async cacheFaceDescriptor(
    userId: string,
    descriptor: number[]
  ): Promise<void> {
    const key = `face_descriptors:${userId}`;
    await this.redis.setex(key, 3600, JSON.stringify(descriptor)); // 1 hour TTL
  }

  async getFaceDescriptor(userId: string): Promise<number[] | null> {
    const key = `face_descriptors:${userId}`;
    const data = await this.redis.get(key);
    return data ? JSON.parse(data) : null;
  }

  async getAllFaceDescriptors(): Promise<{ [userId: string]: number[] }> {
    const pattern = "face_descriptors:*";
    const keys = await this.redis.keys(pattern);

    if (keys.length === 0) return {};

    const values = await this.redis.mget(keys);
    const descriptors: { [userId: string]: number[] } = {};

    keys.forEach((key, index) => {
      const userId = key.replace("face_descriptors:", "");
      if (values[index]) {
        descriptors[userId] = JSON.parse(values[index]);
      }
    });

    return descriptors;
  }

  // Recent attendance cache (prevent duplicate entries)
  async cacheRecentAttendance(
    userId: string,
    type: string,
    timestamp: Date
  ): Promise<void> {
    const key = `recent_attendance:${userId}`;
    const data = { lastType: type, timestamp: timestamp.toISOString() };
    await this.redis.setex(key, 300, JSON.stringify(data)); // 5 minutes TTL
  }

  async getRecentAttendance(
    userId: string
  ): Promise<{ lastType: string; timestamp: string } | null> {
    const key = `recent_attendance:${userId}`;
    const data = await this.redis.get(key);
    return data ? JSON.parse(data) : null;
  }

  // Session cache
  async cacheSession(
    sessionId: string,
    sessionData: any,
    ttlSeconds: number = 3600
  ): Promise<void> {
    const key = `session:${sessionId}`;
    await this.redis.setex(key, ttlSeconds, JSON.stringify(sessionData));
  }

  async getSession(sessionId: string): Promise<any | null> {
    const key = `session:${sessionId}`;
    const data = await this.redis.get(key);
    return data ? JSON.parse(data) : null;
  }

  async deleteSession(sessionId: string): Promise<void> {
    const key = `session:${sessionId}`;
    await this.redis.del(key);
  }

  // Rate limiting
  async checkRateLimit(
    identifier: string,
    windowMs: number,
    maxRequests: number
  ): Promise<{ allowed: boolean; remaining: number; resetTime: number }> {
    const key = `rate_limit:${identifier}`;
    const window = Math.floor(Date.now() / windowMs);
    const windowKey = `${key}:${window}`;

    const pipeline = this.redis.pipeline();
    pipeline.incr(windowKey);
    pipeline.expire(windowKey, Math.ceil(windowMs / 1000));
    const results = await pipeline.exec();

    const requests = (results?.[0]?.[1] as number) || 0;
    const remaining = Math.max(0, maxRequests - requests);
    const resetTime = (window + 1) * windowMs;

    return {
      allowed: requests <= maxRequests,
      remaining,
      resetTime,
    };
  }

  // Generic cache operations
  async set(key: string, value: any, ttlSeconds?: number): Promise<void> {
    const serializedValue = JSON.stringify(value);
    if (ttlSeconds) {
      await this.redis.setex(key, ttlSeconds, serializedValue);
    } else {
      await this.redis.set(key, serializedValue);
    }
  }

  async get(key: string): Promise<any | null> {
    const data = await this.redis.get(key);
    return data ? JSON.parse(data) : null;
  }

  async del(key: string): Promise<void> {
    await this.redis.del(key);
  }

  async exists(key: string): Promise<boolean> {
    const result = await this.redis.exists(key);
    return result === 1;
  }

  async flushPattern(pattern: string): Promise<void> {
    const keys = await this.redis.keys(pattern);
    if (keys.length > 0) {
      await this.redis.del(...keys);
    }
  }
}

// Export singleton instances
export const redisConnection = RedisConnection.getInstance();
export const cacheService = new CacheService();

// Graceful shutdown handler
export const gracefulShutdown = async (): Promise<void> => {
  logger.info("Shutting down Redis connection...");
  await redisConnection.disconnect();
};
