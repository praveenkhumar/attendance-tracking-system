import { FastifyRequest, FastifyReply } from "fastify";
import { AuthService } from "../services/authService";
import { logger } from "../utils/logger";

// Extend FastifyRequest to include user
declare module "fastify" {
  interface FastifyRequest {
    user?: {
      userId: string;
      email: string;
      role: string;
      name: string;
    };
  }
}

export class AuthMiddleware {
  private static authService = AuthService.getInstance();

  static async authenticate(
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<void> {
    try {
      const authHeader = request.headers.authorization;

      if (!authHeader || !authHeader.startsWith("Bearer ")) {
        reply.code(401).send({
          success: false,
          message: "Access token required",
        });
        return;
      }

      const token = authHeader.substring(7); // Remove 'Bearer ' prefix
      const validation = await AuthMiddleware.authService.validateToken(token);

      if (!validation.valid || !validation.user || !validation.payload) {
        reply.code(401).send({
          success: false,
          message: "Invalid or expired token",
        });
        return;
      }

      // Attach user data to request
      request.user = {
        userId: validation.user._id.toString(),
        email: validation.user.email,
        role: validation.user.role,
        name: validation.user.name,
      };
    } catch (error) {
      logger.error("Authentication middleware error:", error);
      reply.code(500).send({
        success: false,
        message: "Internal server error",
      });
    }
  }

  static async requireAdmin(
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<void> {
    try {
      // First run authentication
      await AuthMiddleware.authenticate(request, reply);

      // If authentication failed, reply is already sent
      if (reply.sent) {
        return;
      }

      // Check if user has admin role
      if (!request.user || request.user.role !== "admin") {
        reply.code(403).send({
          success: false,
          message: "Admin access required",
        });
        return;
      }
    } catch (error) {
      logger.error("Admin middleware error:", error);
      reply.code(500).send({
        success: false,
        message: "Internal server error",
      });
    }
  }

  static async optionalAuth(
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<void> {
    try {
      const authHeader = request.headers.authorization;

      if (!authHeader || !authHeader.startsWith("Bearer ")) {
        // No token provided, but that's okay for optional auth
        return;
      }

      const token = authHeader.substring(7);
      const validation = await AuthMiddleware.authService.validateToken(token);

      if (validation.valid && validation.user) {
        request.user = {
          userId: validation.user._id.toString(),
          email: validation.user.email,
          role: validation.user.role,
          name: validation.user.name,
        };
      }
    } catch (error) {
      // For optional auth, we log but don't fail the request
      logger.debug("Optional auth middleware error:", error);
    }
  }

  static extractUserInfo(request: FastifyRequest): {
    ipAddress?: string;
    userAgent?: string;
  } {
    return {
      ipAddress: (request.ip ||
        request.headers["x-forwarded-for"] ||
        request.headers["x-real-ip"] ||
        request.socket.remoteAddress) as string,
      userAgent: request.headers["user-agent"],
    };
  }
}
