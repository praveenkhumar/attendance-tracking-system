import Fastify, { FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import path from "path";
import { appConfig, isDevelopment } from "./utils/config";
import { logger } from "./utils/logger";
import { Database } from "./utils/database";
import { RedisClient } from "./utils/redis";
import { ErrorHandler } from "./middleware/errorHandler";
import { FaceRecognitionService } from "./services/faceRecognitionService";
import { AuthService } from "./services/authService";

// Import routes
import authRoutes from "./routes/auth";
import userRoutes from "./routes/users";
import attendanceRoutes from "./routes/attendance";
import uploadRoutes from "./routes/upload";

export class App {
  private fastify: FastifyInstance;
  private database: Database;
  private redis: RedisClient;

  constructor() {
    this.fastify = Fastify({
      logger: isDevelopment
        ? {
            transport: {
              target: "pino-pretty",
              options: {
                colorize: true,
              },
            },
          }
        : false,
      trustProxy: true,
    });

    this.database = Database.getInstance();
    this.redis = RedisClient.getInstance();
  }

  async initialize(): Promise<void> {
    try {
      // Register plugins
      await this.registerPlugins();

      // Setup error handling
      ErrorHandler.setup(this.fastify);

      // Register routes
      await this.registerRoutes();

      // Initialize services
      await this.initializeServices();

      logger.info("Application initialized successfully");
    } catch (error) {
      logger.error("Failed to initialize application:", error);
      throw error;
    }
  }

  private async registerPlugins(): Promise<void> {
    // CORS
    await this.fastify.register(cors, {
      origin: [appConfig.frontend.url, "http://localhost:3000"],
      credentials: true,
      methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    });

    // Security headers
    await this.fastify.register(helmet, {
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          scriptSrc: ["'self'"],
          imgSrc: ["'self'", "data:", "blob:"],
        },
      },
    });

    // Rate limiting
    await this.fastify.register(rateLimit, {
      max: appConfig.rateLimit.max,
      timeWindow: appConfig.rateLimit.windowMs,
      errorResponseBuilder: () => ({
        success: false,
        message: "Too many requests, please try again later.",
      }),
    });

    // File upload support
    await this.fastify.register(multipart, {
      limits: {
        fileSize: appConfig.upload.maxFileSize,
        files: 1,
      },
    });

    // Static file serving for uploads
    await this.fastify.register(fastifyStatic, {
      root: path.join(process.cwd(), appConfig.upload.directory),
      prefix: "/uploads/",
    });

    // Serve frontend in production
    if (!isDevelopment) {
      await this.fastify.register(fastifyStatic, {
        root: path.join(process.cwd(), "frontend/build"),
        prefix: "/",
        decorateReply: false,
      });

      // Catch-all handler for React Router
      this.fastify.setNotFoundHandler(async (request, reply) => {
        if (request.url.startsWith("/api/")) {
          reply.code(404).send({
            success: false,
            message: "API endpoint not found",
          });
        } else {
          reply.sendFile("index.html");
        }
      });
    }
  }

  private async registerRoutes(): Promise<void> {
    // API routes
    await this.fastify.register(authRoutes, { prefix: "/api/auth" });
    await this.fastify.register(userRoutes, { prefix: "/api/users" });
    await this.fastify.register(attendanceRoutes, {
      prefix: "/api/attendance",
    });
    await this.fastify.register(uploadRoutes, { prefix: "/api/upload" });

    // Health check endpoint
    this.fastify.get("/api/health", async (request, reply) => {
      try {
        const dbHealth = await this.database.healthCheck();
        const redisHealth = await this.redis.healthCheck();

        const health = {
          status: "ok",
          timestamp: new Date().toISOString(),
          services: {
            database: dbHealth ? "healthy" : "unhealthy",
            redis: redisHealth ? "healthy" : "unhealthy",
            faceRecognition:
              FaceRecognitionService.getInstance().isInitialized()
                ? "healthy"
                : "unhealthy",
          },
        };

        const allHealthy = Object.values(health.services).every(
          (status) => status === "healthy"
        );
        reply.code(allHealthy ? 200 : 503).send(health);
      } catch (error) {
        logger.error("Health check error:", error);
        reply.code(503).send({
          status: "error",
          timestamp: new Date().toISOString(),
          message: "Health check failed",
        });
      }
    });
  }

  private async initializeServices(): Promise<void> {
    // Connect to databases
    await this.database.connect(appConfig.mongodb.uri);
    await this.redis.connect(appConfig.redis.url);

    // Initialize face recognition service
    const faceService = FaceRecognitionService.getInstance();
    await faceService.initialize();

    // Create default admin user if none exists
    await this.createDefaultAdmin();

    // Start cleanup tasks
    this.startBackgroundTasks();
  }

  private async createDefaultAdmin(): Promise<void> {
    try {
      const authService = AuthService.getInstance();

      // Check if any admin user exists
      const adminExists = await require("./models/User").User.findOne({
        role: "admin",
      });

      if (!adminExists) {
        const defaultAdmin = {
          name: "Administrator",
          email: "admin@attendance.com",
          password: "admin123",
        };

        const result = await authService.createAdminUser(defaultAdmin);

        if (result.success) {
          logger.warn("Default admin user created:");
          logger.warn(`Email: ${defaultAdmin.email}`);
          logger.warn(`Password: ${defaultAdmin.password}`);
          logger.warn("Please change the password after first login!");
        }
      }
    } catch (error) {
      logger.error("Error creating default admin:", error);
    }
  }

  private startBackgroundTasks(): void {
    // Cleanup expired sessions every hour
    setInterval(async () => {
      try {
        const authService = AuthService.getInstance();
        await authService.cleanupExpiredSessions();
      } catch (error) {
        logger.error("Session cleanup error:", error);
      }
    }, 60 * 60 * 1000); // 1 hour

    // Cleanup old attendance images every day
    setInterval(async () => {
      try {
        const attendanceService =
          require("./services/attendanceService").AttendanceService.getInstance();
        await attendanceService.cleanupOldImages(30); // 30 days
      } catch (error) {
        logger.error("Image cleanup error:", error);
      }
    }, 24 * 60 * 60 * 1000); // 24 hours
  }

  async start(): Promise<void> {
    try {
      await this.fastify.listen({
        port: appConfig.port,
        host: "0.0.0.0",
      });

      logger.info(`Server started on port ${appConfig.port}`);
      logger.info(`Environment: ${appConfig.nodeEnv}`);
      logger.info(`Frontend URL: ${appConfig.frontend.url}`);

      if (isDevelopment) {
        logger.info(
          "API Documentation: http://localhost:" +
            appConfig.port +
            "/api/health"
        );
      }
    } catch (error) {
      logger.error("Failed to start server:", error);
      throw error;
    }
  }

  async stop(): Promise<void> {
    try {
      await this.fastify.close();
      await this.database.disconnect();
      await this.redis.disconnect();
      logger.info("Application stopped successfully");
    } catch (error) {
      logger.error("Error stopping application:", error);
      throw error;
    }
  }

  getFastifyInstance(): FastifyInstance {
    return this.fastify;
  }
}

// Main execution
async function main() {
  const app = new App();

  try {
    await app.initialize();
    await app.start();
  } catch (error) {
    logger.error("Failed to start application:", error);
    process.exit(1);
  }
}

// Start the application if this file is run directly
if (require.main === module) {
  main().catch((error) => {
    logger.error("Unhandled error in main:", error);
    process.exit(1);
  });
}

export { App };
