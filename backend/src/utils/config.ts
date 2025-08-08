import { config } from "dotenv";
import path from "path";

// Load environment variables
config({ path: path.resolve(__dirname, "../../../.env") });

interface Config {
  port: number;
  nodeEnv: string;
  mongodb: {
    uri: string;
    testUri: string;
  };
  redis: {
    url: string;
  };
  jwt: {
    secret: string;
    expiresIn: string;
  };
  upload: {
    directory: string;
    maxFileSize: number;
  };
  face: {
    matchThreshold: number;
    descriptorCacheTtl: number;
  };
  rateLimit: {
    windowMs: number;
    max: number;
  };
  frontend: {
    url: string;
  };
}

export const appConfig: Config = {
  port: parseInt(process.env.PORT || "3001", 10),
  nodeEnv: process.env.NODE_ENV || "development",
  mongodb: {
    uri: process.env.MONGODB_URI || "mongodb://localhost:27017/attendance",
    testUri:
      process.env.MONGODB_TEST_URI ||
      "mongodb://localhost:27017/attendance_test",
  },
  redis: {
    url: process.env.REDIS_URL || "redis://localhost:6379",
  },
  jwt: {
    secret:
      process.env.JWT_SECRET ||
      "your-super-secret-jwt-key-change-in-production",
    expiresIn: process.env.JWT_EXPIRES_IN || "24h",
  },
  upload: {
    directory: process.env.UPLOAD_DIR || "uploads",
    maxFileSize: parseInt(process.env.MAX_FILE_SIZE || "5242880", 10), // 5MB
  },
  face: {
    matchThreshold: parseFloat(process.env.FACE_MATCH_THRESHOLD || "0.6"),
    descriptorCacheTtl: parseInt(
      process.env.FACE_DESCRIPTOR_CACHE_TTL || "3600",
      10
    ),
  },
  rateLimit: {
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW || "900000", 10), // 15 minutes
    max: parseInt(process.env.RATE_LIMIT_MAX || "100", 10),
  },
  frontend: {
    url: process.env.FRONTEND_URL || "http://localhost:3000",
  },
};

export const isDevelopment = appConfig.nodeEnv === "development";
export const isProduction = appConfig.nodeEnv === "production";
export const isTest = appConfig.nodeEnv === "test";
