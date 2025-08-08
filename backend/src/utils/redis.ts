import { createClient, RedisClientType } from "redis";
import { logger } from "./logger";

export class RedisClient {
  private static instance: RedisClient;
  private client: RedisClientType | null = null;
  private isConnected = false;

  private constructor() {}

  public static getInstance(): RedisClient {
    if (!RedisClient.instance) {
      RedisClient.instance = new RedisClient();
    }
    return RedisClient.instance;
  }

  public async connect(url: string): Promise<void> {
    if (this.isConnected && this.client) {
      logger.info("Redis already connected");
      return;
    }

    try {
      this.client = createClient({ url });

      this.client.on("error", (error) => {
        logger.error("Redis connection error:", error);
        this.isConnected = false;
      });

      this.client.on("connect", () => {
        logger.info("Connected to Redis successfully");
        this.isConnected = true;
      });

      this.client.on("disconnect", () => {
        logger.warn("Redis disconnected");
        this.isConnected = false;
      });

      await this.client.connect();
    } catch (error) {
      logger.error("Failed to connect to Redis:", error);
      throw error;
    }
  }

  public async disconnect(): Promise<void> {
    if (this.client && this.isConnected) {
      try {
        await this.client.disconnect();
        this.isConnected = false;
        logger.info("Disconnected from Redis");
      } catch (error) {
        logger.error("Error disconnecting from Redis:", error);
        throw error;
      }
    }
  }

  public getClient(): RedisClientType {
    if (!this.client || !this.isConnected) {
      throw new Error("Redis client is not connected");
    }
    return this.client;
  }

  public async set(key: string, value: string, ttl?: number): Promise<void> {
    const client = this.getClient();
    if (ttl) {
      await client.setEx(key, ttl, value);
    } else {
      await client.set(key, value);
    }
  }

  public async get(key: string): Promise<string | null> {
    const client = this.getClient();
    return await client.get(key);
  }

  public async del(key: string): Promise<void> {
    const client = this.getClient();
    await client.del(key);
  }

  public async exists(key: string): Promise<boolean> {
    const client = this.getClient();
    const result = await client.exists(key);
    return result === 1;
  }

  public async hSet(key: string, field: string, value: string): Promise<void> {
    const client = this.getClient();
    await client.hSet(key, field, value);
  }

  public async hGet(key: string, field: string): Promise<string | undefined> {
    const client = this.getClient();
    return await client.hGet(key, field);
  }

  public async hGetAll(key: string): Promise<Record<string, string>> {
    const client = this.getClient();
    return await client.hGetAll(key);
  }

  public async healthCheck(): Promise<boolean> {
    try {
      if (!this.client || !this.isConnected) {
        return false;
      }
      await this.client.ping();
      return true;
    } catch (error) {
      logger.error("Redis health check failed:", error);
      return false;
    }
  }
}
