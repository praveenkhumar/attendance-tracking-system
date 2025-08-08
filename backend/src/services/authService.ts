import jwt from "jsonwebtoken";
import { Types } from "mongoose";
import { User, IUser } from "../models/User";
import { Session } from "../models/Session";
import { CacheService } from "./cacheService";
import { logger } from "../utils/logger";
import { appConfig } from "../utils/config";
import crypto from "crypto";

export interface TokenPayload {
  userId: string;
  email: string;
  role: string;
  sessionId: string;
}

export interface AuthResult {
  success: boolean;
  user?: IUser;
  token?: string;
  message: string;
}

export class AuthService {
  private static instance: AuthService;
  private cacheService: CacheService;

  private constructor() {
    this.cacheService = new CacheService();
  }

  public static getInstance(): AuthService {
    if (!AuthService.instance) {
      AuthService.instance = new AuthService();
    }
    return AuthService.instance;
  }

  async login(
    email: string,
    password: string,
    ipAddress?: string,
    userAgent?: string
  ): Promise<AuthResult> {
    try {
      logger.debug(`Login attempt for email: ${email}`);

      // Find user by email (include password for comparison)
      const user = await User.findOne({ email: email.toLowerCase() }).select(
        "+password"
      );

      if (!user || !user.isActive) {
        logger.warn(`Login failed - user not found or inactive: ${email}`);
        return {
          success: false,
          message: "Invalid email or password",
        };
      }

      // Check password
      const isPasswordValid = await user.comparePassword(password);
      if (!isPasswordValid) {
        logger.warn(`Login failed - invalid password: ${email}`);
        return {
          success: false,
          message: "Invalid email or password",
        };
      }

      // Generate session ID
      const sessionId = this.generateSessionId();

      // Create session in database
      const expiresAt = new Date(Date.now() + this.getTokenExpirationTime());
      const session = new Session({
        userId: user._id,
        sessionId,
        expiresAt,
        ipAddress,
        userAgent,
      });

      await session.save();

      // Generate JWT token
      const token = this.generateToken({
        userId: user._id.toString(),
        email: user.email,
        role: user.role,
        sessionId,
      });

      // Cache session data
      await this.cacheService.setUserSession(sessionId, {
        userId: user._id.toString(),
        email: user.email,
        role: user.role,
        name: user.name,
      });

      // Remove password from user object
      const userWithoutPassword = user.toJSON();

      logger.info(`Login successful for user: ${email}`);
      return {
        success: true,
        user: userWithoutPassword as IUser,
        token,
        message: "Login successful",
      };
    } catch (error) {
      logger.error("Login error:", error);
      return {
        success: false,
        message: "Internal server error",
      };
    }
  }

  async logout(sessionId: string): Promise<boolean> {
    try {
      logger.debug(`Logout attempt for session: ${sessionId}`);

      // Deactivate session in database
      await Session.updateOne(
        { sessionId, isActive: true },
        { isActive: false }
      );

      // Remove from cache
      await this.cacheService.removeUserSession(sessionId);

      logger.info(`Logout successful for session: ${sessionId}`);
      return true;
    } catch (error) {
      logger.error("Logout error:", error);
      return false;
    }
  }

  async validateToken(
    token: string
  ): Promise<{ valid: boolean; payload?: TokenPayload; user?: IUser }> {
    try {
      // Decode and verify token
      const decoded = jwt.verify(token, appConfig.jwt.secret) as TokenPayload;

      if (!decoded.sessionId || !decoded.userId) {
        return { valid: false };
      }

      // Check cached session first
      const cachedSession = await this.cacheService.getUserSession(
        decoded.sessionId
      );
      if (cachedSession) {
        const user = await User.findById(decoded.userId);
        if (user && user.isActive) {
          return { valid: true, payload: decoded, user };
        }
      }

      // Check database session
      const session = await Session.findActiveSession(decoded.sessionId);
      if (!session || !session.isValid()) {
        return { valid: false };
      }

      const user = await User.findById(decoded.userId);
      if (!user || !user.isActive) {
        return { valid: false };
      }

      // Re-cache session data
      await this.cacheService.setUserSession(decoded.sessionId, {
        userId: user._id.toString(),
        email: user.email,
        role: user.role,
        name: user.name,
      });

      return { valid: true, payload: decoded, user };
    } catch (error) {
      logger.debug("Token validation failed:", error);
      return { valid: false };
    }
  }

  async refreshToken(oldToken: string): Promise<AuthResult> {
    try {
      const validation = await this.validateToken(oldToken);
      if (!validation.valid || !validation.payload || !validation.user) {
        return {
          success: false,
          message: "Invalid token",
        };
      }

      // Generate new session ID
      const newSessionId = this.generateSessionId();

      // Update session in database
      await Session.updateOne(
        { sessionId: validation.payload.sessionId },
        {
          sessionId: newSessionId,
          expiresAt: new Date(Date.now() + this.getTokenExpirationTime()),
        }
      );

      // Generate new token
      const newToken = this.generateToken({
        userId: validation.payload.userId,
        email: validation.payload.email,
        role: validation.payload.role,
        sessionId: newSessionId,
      });

      // Update cache
      await this.cacheService.removeUserSession(validation.payload.sessionId);
      await this.cacheService.setUserSession(newSessionId, {
        userId: validation.user._id.toString(),
        email: validation.user.email,
        role: validation.user.role,
        name: validation.user.name,
      });

      logger.info(`Token refreshed for user: ${validation.user.email}`);
      return {
        success: true,
        user: validation.user,
        token: newToken,
        message: "Token refreshed successfully",
      };
    } catch (error) {
      logger.error("Token refresh error:", error);
      return {
        success: false,
        message: "Failed to refresh token",
      };
    }
  }

  async logoutAllSessions(userId: Types.ObjectId): Promise<boolean> {
    try {
      // Deactivate all database sessions
      await Session.deactivateUserSessions(userId);

      // Note: We can't easily remove all cached sessions without knowing session IDs
      // In a production system, you might want to maintain a user->sessions mapping

      logger.info(`All sessions logged out for user: ${userId}`);
      return true;
    } catch (error) {
      logger.error("Logout all sessions error:", error);
      return false;
    }
  }

  async createAdminUser(userData: {
    name: string;
    email: string;
    password: string;
  }): Promise<AuthResult> {
    try {
      logger.debug(`Creating admin user: ${userData.email}`);

      // Check if user already exists
      const existingUser = await User.findOne({
        email: userData.email.toLowerCase(),
      });
      if (existingUser) {
        return {
          success: false,
          message: "User already exists",
        };
      }

      // Create admin user
      const adminUser = new User({
        name: userData.name,
        email: userData.email.toLowerCase(),
        password: userData.password,
        role: "admin",
        isActive: true,
      });

      await adminUser.save();

      const userWithoutPassword = adminUser.toJSON();

      logger.info(`Admin user created: ${userData.email}`);
      return {
        success: true,
        user: userWithoutPassword as IUser,
        message: "Admin user created successfully",
      };
    } catch (error) {
      logger.error("Create admin user error:", error);
      return {
        success: false,
        message: "Failed to create admin user",
      };
    }
  }

  async changePassword(
    userId: Types.ObjectId,
    oldPassword: string,
    newPassword: string
  ): Promise<AuthResult> {
    try {
      const user = await User.findById(userId).select("+password");
      if (!user) {
        return {
          success: false,
          message: "User not found",
        };
      }

      const isOldPasswordValid = await user.comparePassword(oldPassword);
      if (!isOldPasswordValid) {
        return {
          success: false,
          message: "Current password is incorrect",
        };
      }

      user.password = newPassword;
      await user.save();

      // Logout all sessions to force re-login with new password
      await this.logoutAllSessions(userId);

      logger.info(`Password changed for user: ${user.email}`);
      return {
        success: true,
        message: "Password changed successfully",
      };
    } catch (error) {
      logger.error("Change password error:", error);
      return {
        success: false,
        message: "Failed to change password",
      };
    }
  }

  private generateToken(payload: TokenPayload): string {
    return jwt.sign(payload, appConfig.jwt.secret, {
      expiresIn: appConfig.jwt.expiresIn,
    });
  }

  private generateSessionId(): string {
    return crypto.randomBytes(32).toString("hex");
  }

  private getTokenExpirationTime(): number {
    // Convert JWT expiration to milliseconds
    const expiresIn = appConfig.jwt.expiresIn;
    if (expiresIn.endsWith("h")) {
      return parseInt(expiresIn) * 60 * 60 * 1000;
    } else if (expiresIn.endsWith("d")) {
      return parseInt(expiresIn) * 24 * 60 * 60 * 1000;
    } else if (expiresIn.endsWith("m")) {
      return parseInt(expiresIn) * 60 * 1000;
    }
    return 24 * 60 * 60 * 1000; // Default to 24 hours
  }

  async cleanupExpiredSessions(): Promise<void> {
    try {
      const result = await Session.deleteMany({
        $or: [{ expiresAt: { $lt: new Date() } }, { isActive: false }],
      });

      if (result.deletedCount > 0) {
        logger.info(`Cleaned up ${result.deletedCount} expired sessions`);
      }
    } catch (error) {
      logger.error("Session cleanup error:", error);
    }
  }
}
