import { RedisClient } from "../utils/redis";
import { logger } from "../utils/logger";
import { Types } from "mongoose";

export class CacheService {
  private redis: RedisClient;
  private readonly FACE_DESCRIPTORS_KEY = "face_descriptors";
  private readonly USER_SESSION_PREFIX = "session:";
  private readonly RECENT_ATTENDANCE_PREFIX = "recent_attendance:";
  private readonly USER_DATA_PREFIX = "user:";

  constructor() {
    this.redis = RedisClient.getInstance();
  }

  // Face descriptor operations
  async setFaceDescriptor(userId: string, descriptor: number[]): Promise<void> {
    try {
      await this.redis.hSet(
        this.FACE_DESCRIPTORS_KEY,
        userId,
        JSON.stringify(descriptor)
      );
      logger.debug(`Cached face descriptor for user ${userId}`);
    } catch (error) {
      logger.error("Error caching face descriptor:", error);
      throw error;
    }
  }

  async getFaceDescriptor(userId: string): Promise<number[] | null> {
    try {
      const descriptorStr = await this.redis.hGet(
        this.FACE_DESCRIPTORS_KEY,
        userId
      );
      if (!descriptorStr) {
        return null;
      }
      return JSON.parse(descriptorStr);
    } catch (error) {
      logger.error("Error retrieving face descriptor:", error);
      return null;
    }
  }

  async getAllFaceDescriptors(): Promise<Record<string, number[]>> {
    try {
      const descriptors = await this.redis.hGetAll(this.FACE_DESCRIPTORS_KEY);
      const parsed: Record<string, number[]> = {};

      for (const [userId, descriptorStr] of Object.entries(descriptors)) {
        try {
          parsed[userId] = JSON.parse(descriptorStr);
        } catch (parseError) {
          logger.error(
            `Error parsing descriptor for user ${userId}:`,
            parseError
          );
        }
      }

      return parsed;
    } catch (error) {
      logger.error("Error retrieving all face descriptors:", error);
      return {};
    }
  }

  async removeFaceDescriptor(userId: string): Promise<void> {
    try {
      const client = this.redis.getClient();
      await client.hDel(this.FACE_DESCRIPTORS_KEY, userId);
      logger.debug(`Removed face descriptor for user ${userId}`);
    } catch (error) {
      logger.error("Error removing face descriptor:", error);
      throw error;
    }
  }

  // Session operations
  async setUserSession(
    sessionId: string,
    userData: any,
    ttl: number = 86400
  ): Promise<void> {
    try {
      const key = this.USER_SESSION_PREFIX + sessionId;
      await this.redis.set(key, JSON.stringify(userData), ttl);
      logger.debug(`Cached session ${sessionId}`);
    } catch (error) {
      logger.error("Error caching session:", error);
      throw error;
    }
  }

  async getUserSession(sessionId: string): Promise<any | null> {
    try {
      const key = this.USER_SESSION_PREFIX + sessionId;
      const sessionData = await this.redis.get(key);
      if (!sessionData) {
        return null;
      }
      return JSON.parse(sessionData);
    } catch (error) {
      logger.error("Error retrieving session:", error);
      return null;
    }
  }

  async removeUserSession(sessionId: string): Promise<void> {
    try {
      const key = this.USER_SESSION_PREFIX + sessionId;
      await this.redis.del(key);
      logger.debug(`Removed session ${sessionId}`);
    } catch (error) {
      logger.error("Error removing session:", error);
      throw error;
    }
  }

  // Recent attendance operations
  async setRecentAttendance(
    userId: string,
    attendanceData: { lastType: "ENTRY" | "EXIT"; timestamp: string },
    ttl: number = 3600
  ): Promise<void> {
    try {
      const key = this.RECENT_ATTENDANCE_PREFIX + userId;
      await this.redis.set(key, JSON.stringify(attendanceData), ttl);
      logger.debug(`Cached recent attendance for user ${userId}`);
    } catch (error) {
      logger.error("Error caching recent attendance:", error);
      throw error;
    }
  }

  async getRecentAttendance(
    userId: string
  ): Promise<{ lastType: "ENTRY" | "EXIT"; timestamp: string } | null> {
    try {
      const key = this.RECENT_ATTENDANCE_PREFIX + userId;
      const attendanceData = await this.redis.get(key);
      if (!attendanceData) {
        return null;
      }
      return JSON.parse(attendanceData);
    } catch (error) {
      logger.error("Error retrieving recent attendance:", error);
      return null;
    }
  }

  async removeRecentAttendance(userId: string): Promise<void> {
    try {
      const key = this.RECENT_ATTENDANCE_PREFIX + userId;
      await this.redis.del(key);
      logger.debug(`Removed recent attendance cache for user ${userId}`);
    } catch (error) {
      logger.error("Error removing recent attendance cache:", error);
      throw error;
    }
  }

  // User data operations
  async cacheUserData(
    userId: string,
    userData: any,
    ttl: number = 1800
  ): Promise<void> {
    try {
      const key = this.USER_DATA_PREFIX + userId;
      await this.redis.set(key, JSON.stringify(userData), ttl);
      logger.debug(`Cached user data for user ${userId}`);
    } catch (error) {
      logger.error("Error caching user data:", error);
      throw error;
    }
  }

  async getCachedUserData(userId: string): Promise<any | null> {
    try {
      const key = this.USER_DATA_PREFIX + userId;
      const userData = await this.redis.get(key);
      if (!userData) {
        return null;
      }
      return JSON.parse(userData);
    } catch (error) {
      logger.error("Error retrieving cached user data:", error);
      return null;
    }
  }

  async invalidateUserCache(userId: string): Promise<void> {
    try {
      const keys = [
        this.USER_DATA_PREFIX + userId,
        this.RECENT_ATTENDANCE_PREFIX + userId,
      ];

      for (const key of keys) {
        await this.redis.del(key);
      }

      // Also remove face descriptor
      await this.removeFaceDescriptor(userId);

      logger.debug(`Invalidated all cache for user ${userId}`);
    } catch (error) {
      logger.error("Error invalidating user cache:", error);
      throw error;
    }
  }

  // Generic operations
  async exists(key: string): Promise<boolean> {
    try {
      return await this.redis.exists(key);
    } catch (error) {
      logger.error("Error checking key existence:", error);
      return false;
    }
  }

  async flushAll(): Promise<void> {
    try {
      const client = this.redis.getClient();
      await client.flushAll();
      logger.info("Flushed all cache");
    } catch (error) {
      logger.error("Error flushing cache:", error);
      throw error;
    }
  }

  // Preload face descriptors from database
  async preloadFaceDescriptors(): Promise<void> {
    try {
      // This will be called during app startup to load existing face descriptors
      logger.info(
        "Face descriptor preloading will be implemented after User service is created"
      );
    } catch (error) {
      logger.error("Error preloading face descriptors:", error);
      throw error;
    }
  }
}
