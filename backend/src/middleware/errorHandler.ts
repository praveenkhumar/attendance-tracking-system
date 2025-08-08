import {
  FastifyInstance,
  FastifyError,
  FastifyRequest,
  FastifyReply,
} from "fastify";
import { logger } from "../utils/logger";
import { isProduction } from "../utils/config";

export class ErrorHandler {
  static setup(fastify: FastifyInstance): void {
    // Global error handler
    fastify.setErrorHandler(
      async (
        error: FastifyError,
        request: FastifyRequest,
        reply: FastifyReply
      ) => {
        logger.error("Fastify error:", {
          error: error.message,
          stack: error.stack,
          url: request.url,
          method: request.method,
          statusCode: error.statusCode || 500,
        });

        // Handle different types of errors
        if (error.statusCode) {
          // Known HTTP errors
          reply.code(error.statusCode).send({
            success: false,
            message: error.message,
            ...(isProduction ? {} : { stack: error.stack }),
          });
        } else if (error.name === "ValidationError") {
          // Mongoose validation errors
          reply.code(400).send({
            success: false,
            message: "Validation error",
            errors: Object.values(error as any).map((err: any) => err.message),
          });
        } else if (error.name === "CastError") {
          // MongoDB ObjectId errors
          reply.code(400).send({
            success: false,
            message: "Invalid ID format",
          });
        } else if (
          error.name === "MongoError" &&
          (error as any).code === 11000
        ) {
          // MongoDB duplicate key errors
          reply.code(409).send({
            success: false,
            message: "Duplicate entry found",
          });
        } else if (error.name === "JsonWebTokenError") {
          // JWT errors
          reply.code(401).send({
            success: false,
            message: "Invalid token",
          });
        } else if (error.name === "TokenExpiredError") {
          // JWT expiration errors
          reply.code(401).send({
            success: false,
            message: "Token expired",
          });
        } else {
          // Unknown errors
          reply.code(500).send({
            success: false,
            message: isProduction ? "Internal server error" : error.message,
            ...(isProduction ? {} : { stack: error.stack }),
          });
        }
      }
    );

    // Not found handler
    fastify.setNotFoundHandler(
      async (request: FastifyRequest, reply: FastifyReply) => {
        logger.warn(`404 - Route not found: ${request.method} ${request.url}`);
        reply.code(404).send({
          success: false,
          message: `Route ${request.method} ${request.url} not found`,
        });
      }
    );

    // Add request logging
    fastify.addHook("onRequest", async (request: FastifyRequest) => {
      logger.debug(`${request.method} ${request.url}`, {
        ip: request.ip,
        userAgent: request.headers["user-agent"],
      });
    });

    // Add response logging
    fastify.addHook(
      "onResponse",
      async (request: FastifyRequest, reply: FastifyReply) => {
        const responseTime = reply.getResponseTime();
        logger.debug(
          `${request.method} ${request.url} - ${reply.statusCode} - ${responseTime}ms`
        );
      }
    );

    // Handle uncaught exceptions
    process.on("uncaughtException", (error) => {
      logger.error("Uncaught Exception:", error);
      process.exit(1);
    });

    // Handle unhandled promise rejections
    process.on("unhandledRejection", (reason, promise) => {
      logger.error(
        "Unhandled Promise Rejection at:",
        promise,
        "reason:",
        reason
      );
      process.exit(1);
    });

    // Graceful shutdown
    process.on("SIGTERM", () => {
      logger.info("SIGTERM received, shutting down gracefully");
      fastify.close(() => {
        logger.info("Process terminated");
        process.exit(0);
      });
    });

    process.on("SIGINT", () => {
      logger.info("SIGINT received, shutting down gracefully");
      fastify.close(() => {
        logger.info("Process terminated");
        process.exit(0);
      });
    });
  }

  static async rateLimitErrorHandler(
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<void> {
    reply.code(429).send({
      success: false,
      message: "Too many requests, please try again later",
    });
  }

  static async validationErrorHandler(
    error: any,
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<void> {
    logger.warn("Validation error:", {
      error: error.message,
      url: request.url,
      method: request.method,
    });

    reply.code(400).send({
      success: false,
      message: "Validation failed",
      errors: error.details?.map((detail: any) => detail.message) || [
        error.message,
      ],
    });
  }

  static async multipartErrorHandler(
    error: any,
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<void> {
    logger.warn("Multipart error:", {
      error: error.message,
      url: request.url,
      method: request.method,
    });

    if (error.code === "LIMIT_FILE_SIZE") {
      reply.code(413).send({
        success: false,
        message: "File too large",
      });
    } else if (error.code === "LIMIT_FILE_COUNT") {
      reply.code(400).send({
        success: false,
        message: "Too many files",
      });
    } else {
      reply.code(400).send({
        success: false,
        message: "File upload error",
      });
    }
  }
}
