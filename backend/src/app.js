// backend/src/app.js - Updated with route integration
const fastify = require("fastify");
const path = require("path");
const config = require("./config");
const { connectDB, connectRedis } = require("./config/database");
const { authService } = require("./services");
const { AppError, handleError } = require("./utils/errors");

/**
 * Build and configure Fastify application
 */
async function buildApp(options = {}) {
  const app = fastify({
    logger: {
      level: config.logLevel,
      prettyPrint: process.env.NODE_ENV === "development",
    },
    trustProxy: true,
    ...options,
  });

  try {
    // Connect to databases
    await connectDB();
    await connectRedis();

    app.log.info("Database connections established");

    // Register CORS plugin
    await app.register(require("@fastify/cors"), {
      origin:
        process.env.NODE_ENV === "production"
          ? [process.env.FRONTEND_URL || "http://localhost:3000"]
          : true,
      credentials: true,
      methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
      allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With"],
    });

    // Register cookie support
    await app.register(require("@fastify/cookie"), {
      secret: config.sessionSecret,
      parseOptions: {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "strict",
      },
    });

    // Register rate limiting
    await app.register(require("@fastify/rate-limit"), {
      global: true,
      max: 100,
      timeWindow: "1 minute",
      errorResponseBuilder: function (request, context) {
        return {
          error: "Rate limit exceeded",
          message: `Too many requests. Try again in ${Math.round(
            context.ttl / 1000
          )} seconds.`,
          retryAfter: Math.round(context.ttl / 1000),
        };
      },
    });

    // Register security headers
    await app.register(require("@fastify/helmet"), {
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          scriptSrc: ["'self'"],
          imgSrc: ["'self'", "data:", "blob:"],
          connectSrc: ["'self'"],
          fontSrc: ["'self'"],
          objectSrc: ["'none'"],
          mediaSrc: ["'self'"],
          frameSrc: ["'none'"],
        },
      },
    });

    // Register authentication middleware
    app.decorate("authenticate", async function (request, reply) {
      try {
        const token = request.cookies.sessionToken;

        if (!token) {
          throw new AppError("Authentication required", 401);
        }

        const sessionData = await authService.validateSession(token);

        if (!sessionData || !sessionData.isValid) {
          reply.clearCookie("sessionToken");
          throw new AppError("Invalid or expired session", 401);
        }

        // Attach user data to request
        request.user = sessionData.user;
        request.sessionId = sessionData.sessionId;
        request.sessionExpiresAt = sessionData.expiresAt;
      } catch (error) {
        if (error instanceof AppError) {
          throw error;
        }

        app.log.error("Authentication middleware error:", error);
        throw new AppError("Authentication failed", 401);
      }
    });

    // Register role-based authorization middleware
    app.decorate("requireRole", function (requiredRole) {
      return async function (request, reply) {
        if (!request.user) {
          throw new AppError("Authentication required", 401);
        }

        if (request.user.role !== requiredRole && requiredRole !== "user") {
          throw new AppError("Insufficient permissions", 403);
        }
      };
    });

    // Request logging middleware
    app.addHook("onRequest", async (request, reply) => {
      request.startTime = Date.now();

      // Log request details (exclude sensitive data)
      const logData = {
        method: request.method,
        url: request.url,
        ip: request.ip,
        userAgent: request.headers["user-agent"],
      };

      if (request.user) {
        logData.userId = request.user.id;
        logData.userEmail = request.user.email;
      }

      app.log.info("Incoming request", logData);
    });

    // Response logging middleware
    app.addHook("onResponse", async (request, reply) => {
      const responseTime = Date.now() - request.startTime;

      app.log.info("Request completed", {
        method: request.method,
        url: request.url,
        statusCode: reply.statusCode,
        responseTime: `${responseTime}ms`,
        userId: request.user?.id,
      });
    });

    // Global error handler
    app.setErrorHandler(async (error, request, reply) => {
      return handleError(error, request, reply);
    });

    // Register API routes with prefix
    await app.register(require("./routes"), { prefix: "/api" });

    // Serve static files in production (if needed)
    if (process.env.NODE_ENV === "production") {
      const staticPath = path.join(__dirname, "../../public");
      app.register(require("@fastify/static"), {
        root: staticPath,
        prefix: "/public/",
      });
    }

    // Graceful shutdown handling
    const gracefulClose = async (signal) => {
      app.log.info(`Received ${signal}, shutting down gracefully...`);

      try {
        // Close server
        await app.close();

        // Close database connections
        const mongoose = require("mongoose");
        await mongoose.connection.close();

        // Close Redis connection
        const { cacheService } = require("./services");
        await cacheService.disconnect();

        app.log.info("Graceful shutdown completed");
        process.exit(0);
      } catch (error) {
        app.log.error("Error during graceful shutdown:", error);
        process.exit(1);
      }
    };

    // Handle shutdown signals
    process.on("SIGTERM", () => gracefulClose("SIGTERM"));
    process.on("SIGINT", () => gracefulClose("SIGINT"));

    // Handle uncaught exceptions
    process.on("uncaughtException", (error) => {
      app.log.fatal("Uncaught exception:", error);
      process.exit(1);
    });

    process.on("unhandledRejection", (reason, promise) => {
      app.log.fatal("Unhandled rejection at:", promise, "reason:", reason);
      process.exit(1);
    });

    app.log.info("Application configured successfully");

    return app;
  } catch (error) {
    app.log.error("Failed to configure application:", error);
    throw error;
  }
}

module.exports = buildApp;
