// backend/src/utils/database.ts
import mongoose from "mongoose";
import { logger } from "./logger";
import { config } from "./config";

class DatabaseConnection {
  private static instance: DatabaseConnection;
  private isConnected: boolean = false;

  private constructor() {}

  public static getInstance(): DatabaseConnection {
    if (!DatabaseConnection.instance) {
      DatabaseConnection.instance = new DatabaseConnection();
    }
    return DatabaseConnection.instance;
  }

  public async connect(): Promise<void> {
    if (this.isConnected) {
      logger.info("Database already connected");
      return;
    }

    try {
      const options: mongoose.ConnectOptions = {
        maxPoolSize: 10, // Maintain up to 10 socket connections
        serverSelectionTimeoutMS: 5000, // Keep trying to send operations for 5 seconds
        socketTimeoutMS: 45000, // Close sockets after 45 seconds of inactivity
        bufferMaxEntries: 0, // Disable mongoose buffering
        bufferCommands: false, // Disable mongoose buffering
      };

      await mongoose.connect(config.mongodb.uri, options);
      this.isConnected = true;

      logger.info("Successfully connected to MongoDB", {
        host: config.mongodb.uri.split("@")[1] || "localhost",
        database: config.mongodb.uri.split("/").pop(),
      });

      // Handle connection events
      mongoose.connection.on("error", (err) => {
        logger.error("MongoDB connection error:", err);
        this.isConnected = false;
      });

      mongoose.connection.on("disconnected", () => {
        logger.warn("MongoDB disconnected");
        this.isConnected = false;
      });

      mongoose.connection.on("reconnected", () => {
        logger.info("MongoDB reconnected");
        this.isConnected = true;
      });
    } catch (error) {
      this.isConnected = false;
      logger.error("Failed to connect to MongoDB:", error);
      throw error;
    }
  }

  public async disconnect(): Promise<void> {
    if (!this.isConnected) {
      return;
    }

    try {
      await mongoose.connection.close();
      this.isConnected = false;
      logger.info("MongoDB connection closed");
    } catch (error) {
      logger.error("Error closing MongoDB connection:", error);
      throw error;
    }
  }

  public isConnectionReady(): boolean {
    return this.isConnected && mongoose.connection.readyState === 1;
  }

  public async healthCheck(): Promise<{ status: string; details: any }> {
    try {
      if (!this.isConnected) {
        return {
          status: "disconnected",
          details: { readyState: mongoose.connection.readyState },
        };
      }

      // Perform a simple operation to test connectivity
      await mongoose.connection.db.admin().ping();

      return {
        status: "healthy",
        details: {
          readyState: mongoose.connection.readyState,
          host: mongoose.connection.host,
          port: mongoose.connection.port,
          name: mongoose.connection.name,
        },
      };
    } catch (error) {
      return {
        status: "error",
        details: { error: (error as Error).message },
      };
    }
  }
}

// Export singleton instance
export const database = DatabaseConnection.getInstance();

// Model imports and initialization
export const initializeModels = async (): Promise<void> => {
  try {
    // Import models to register them with mongoose
    await import("../models/User");
    await import("../models/Attendance");
    await import("../models/Session");

    logger.info("Database models initialized successfully");
  } catch (error) {
    logger.error("Failed to initialize database models:", error);
    throw error;
  }
};

// Graceful shutdown handler
export const gracefulShutdown = async (): Promise<void> => {
  logger.info("Shutting down database connection...");
  await database.disconnect();
};
