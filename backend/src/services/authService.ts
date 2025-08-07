// backend/src/services/authService.ts
import jwt from "jsonwebtoken";
import bcrypt from "bcrypt";
import crypto from "crypto";
import { User, IUser } from "../models/User";
import { Session, ISession } from "../models/Session";
import { cacheService } from "../utils/redis";
import { logger } from "../utils/logger";
import { config } from "../utils/config";

export interface LoginCredentials {
  email: string;
  password: string;
}

export interface AuthToken {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  tokenType: string;
}

export interface TokenPayload {
  userId: string;
  email: string;
  role: string;
  sessionId: string;
  iat: number;
  exp: number;
}

export interface SessionInfo {
  user: Partial<IUser>;
  session: Partial<ISession>;
  permissions: string[];
}

export class AuthService {
  private static instance: AuthService;
  private readonly ACCESS_TOKEN_EXPIRY = "15m"; // 15 minutes
  private readonly REFRESH_TOKEN_EXPIRY = "7d"; // 7 days
  private readonly SALT_ROUNDS = 12;

  private constructor() {}

  public static getInstance(): AuthService {
    if (!AuthService.instance) {
      AuthService.instance = new AuthService();
    }
    return AuthService.instance;
  }

  /**
   * Create admin user (for initial setup)
   */
  public async createAdminUser(userData: {
    name: string;
    email: string;
    password: string;
    faceDescriptor: number[];
  }): Promise<IUser> {
    try {
      // Check if admin already exists
      const existingAdmin = await User.findOne({ email: userData.email });
      if (existingAdmin) {
        throw new Error("Admin user already exists");
      }

      // Hash password
      const hashedPassword = await this.hashPassword(userData.password);

      // Create user (Note: In real implementation, you'd have a separate Admin model)
      const adminUser = new User({
        name: userData.name,
        email: userData.email,
        faceDescriptor: userData.faceDescriptor,
        isActive: true,
        // Additional admin fields would go here in a real implementation
      });

      await adminUser.save();

      // Store password separately (in real implementation, use Admin model)
      // For now, we'll store in a separate collection or use a flag

      logger.info("Admin user created successfully", { email: userData.email });
      return adminUser;
    } catch (error) {
      logger.error("Error creating admin user:", error);
      throw error;
    }
  }

  /**
   * Authenticate user with email and password
   */
  public async login(
    credentials: LoginCredentials,
    ipAddress?: string,
    userAgent?: string
  ): Promise<AuthToken> {
    try {
      // Find user by email
      const user = await User.findOne({
        email: credentials.email.toLowerCase(),
        isActive: true,
      });

      if (!user) {
        throw new Error("Invalid credentials");
      }

      // Verify password (In real implementation, check against admin model)
      // For now, we'll use a simple check
      const isValidPassword = await this.verifyPassword(
        credentials.password,
        user
      );
      if (!isValidPassword) {
        throw new Error("Invalid credentials");
      }

      // Generate tokens
      const sessionId = this.generateSessionId();
      const tokens = await this.generateTokens(user, sessionId);

      // Create session record
      const session = new Session({
        userId: user._id,
        token: tokens.accessToken,
        role: "admin", // In real implementation, get from user role
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days
        ipAddress,
        userAgent,
        isActive: true,
        lastAccessedAt: new Date(),
      });

      await session.save();

      // Cache session
      await cacheService.cacheSession(
        sessionId,
        {
          userId: user._id.toString(),
          email: user.email,
          role: "admin",
          sessionId,
        },
        15 * 60
      ); // 15 minutes (access token expiry)

      logger.info("User login successful", {
        userId: user._id,
        email: user.email,
        ipAddress,
      });

      return tokens;
    } catch (error) {
      logger.error("Login error:", error);
      throw error;
    }
  }

  /**
   * Logout user
   */
  public async logout(token: string): Promise<void> {
    try {
      const payload = this.verifyToken(token);

      // Deactivate session in database
      await Session.findOneAndUpdate(
        { token, isActive: true },
        { isActive: false, updatedAt: new Date() }
      );

      // Remove from cache
      await cacheService.deleteSession(payload.sessionId);

      logger.info("User logout successful", {
        userId: payload.userId,
        sessionId: payload.sessionId,
      });
    } catch (error) {
      logger.error("Logout error:", error);
      throw error;
    }
  }

  /**
   * Refresh access token
   */
  public async refreshToken(refreshToken: string): Promise<AuthToken> {
    try {
      const payload = this.verifyToken(refreshToken);

      // Verify session is still active
      const session = await Session.findOne({
        userId: payload.userId,
        isActive: true,
        expiresAt: { $gt: new Date() },
      });

      if (!session) {
        throw new Error("Invalid or expired session");
      }

      // Get user
      const user = await User.findById(payload.userId);
      if (!user || !user.isActive) {
        throw new Error("User not found or inactive");
      }

      // Generate new tokens
      const newSessionId = this.generateSessionId();
      const tokens = await this.generateTokens(user, newSessionId);

      // Update session
      session.token = tokens.accessToken;
      session.lastAccessedAt = new Date();
      await session.save();

      // Update cache
      await cacheService.cacheSession(
        newSessionId,
        {
          userId: user._id.toString(),
          email: user.email,
          role: "admin",
          sessionId: newSessionId,
        },
        15 * 60
      );

      logger.info("Token refresh successful", { userId: user._id });

      return tokens;
    } catch (error) {
      logger.error("Token refresh error:", error);
      throw error;
    }
  }

  /**
   * Verify and decode JWT token
   */
  public verifyToken(token: string): TokenPayload {
    try {
      const payload = jwt.verify(token, config.auth.jwtSecret) as TokenPayload;
      return payload;
    } catch (error) {
      if (error instanceof jwt.TokenExpiredError) {
        throw new Error("Token expired");
      } else if (error instanceof jwt.JsonWebTokenError) {
        throw new Error("Invalid token");
      }
      throw new Error("Token verification failed");
    }
  }

  /**
   * Get session information
   */
  public async getSessionInfo(token: string): Promise<SessionInfo> {
    try {
      const payload = this.verifyToken(token);

      // Try cache first
      let sessionData = await cacheService.getSession(payload.sessionId);

      if (!sessionData) {
        // Fallback to database
        const session = await Session.findOne({
          token,
          isActive: true,
          expiresAt: { $gt: new Date() },
        }).populate("userId", "name email isActive");

        if (!session) {
          throw new Error("Session not found or expired");
        }

        const user = session.userId as any;
        sessionData = {
          userId: user._id.toString(),
          email: user.email,
          role: session.role,
          sessionId: payload.sessionId,
        };

        // Cache for future requests
        await cacheService.cacheSession(
          payload.sessionId,
          sessionData,
          15 * 60
        );
      }

      return {
        user: {
          _id: sessionData.userId,
          email: sessionData.email,
          name: sessionData.name,
        },
        session: {
          _id: payload.sessionId,
          role: sessionData.role,
          lastAccessedAt: new Date(),
        },
        permissions: this.getPermissions(sessionData.role),
      };
    } catch (error) {
      logger.error("Session info error:", error);
      throw error;
    }
  }

  /**
   * Validate session and update last accessed
   */
  public async validateSession(token: string): Promise<boolean> {
    try {
      const payload = this.verifyToken(token);

      // Check if session exists and is active
      const session = await Session.findOne({
        token,
        isActive: true,
        expiresAt: { $gt: new Date() },
      });

      if (!session) {
        return false;
      }

      // Update last accessed time
      session.lastAccessedAt = new Date();
      await session.save();

      return true;
    } catch (error) {
      return false;
    }
  }

  /**
   * Logout all sessions for a user
   */
  public async logoutAllSessions(userId: string): Promise<void> {
    try {
      // Deactivate all sessions in database
      await Session.updateMany(
        { userId, isActive: true },
        { isActive: false, updatedAt: new Date() }
      );

      // Clear all cached sessions for user
      // Note: This is a simplified approach. In production, you might want to track session IDs
      await cacheService.flushPattern(`session:*`);

      logger.info("All sessions logged out", { userId });
    } catch (error) {
      logger.error("Logout all sessions error:", error);
      throw error;
    }
  }

  /**
   * Clean up expired sessions
   */
  public async cleanupExpiredSessions(): Promise<void> {
    try {
      const result = await Session.cleanupExpiredSessions();
      logger.info(`Cleaned up ${result.deletedCount} expired sessions`);
    } catch (error) {
      logger.error("Session cleanup error:", error);
    }
  }

  /**
   * Generate JWT tokens
   */
  private async generateTokens(
    user: IUser,
    sessionId: string
  ): Promise<AuthToken> {
    const payload = {
      userId: user._id.toString(),
      email: user.email,
      role: "admin", // In real implementation, get from user
      sessionId,
    };

    const accessToken = jwt.sign(payload, config.auth.jwtSecret, {
      expiresIn: this.ACCESS_TOKEN_EXPIRY,
    });

    const refreshToken = jwt.sign(payload, config.auth.jwtSecret, {
      expiresIn: this.REFRESH_TOKEN_EXPIRY,
    });

    return {
      accessToken,
      refreshToken,
      expiresIn: 15 * 60, // 15 minutes in seconds
      tokenType: "Bearer",
    };
  }

  /**
   * Hash password
   */
  private async hashPassword(password: string): Promise<string> {
    return bcrypt.hash(password, this.SALT_ROUNDS);
  }

  /**
   * Verify password (simplified - in real implementation, check against admin model)
   */
  private async verifyPassword(
    password: string,
    user: IUser
  ): Promise<boolean> {
    // This is a simplified implementation
    // In real implementation, you'd have stored hashed passwords
    return password === "admin123"; // Temporary for demo
  }

  /**
   * Generate session ID
   */
  private generateSessionId(): string {
    return crypto.randomBytes(32).toString("hex");
  }

  /**
   * Get user permissions based on role
   */
  private getPermissions(role: string): string[] {
    switch (role) {
      case "admin":
        return [
          "users:read",
          "users:write",
          "users:delete",
          "attendance:read",
          "attendance:write",
          "attendance:stats",
          "system:health",
        ];
      case "user":
        return ["attendance:read:own", "attendance:write:own"];
      default:
        return [];
    }
  }
}

// Export singleton instance
export const authService = AuthService.getInstance();
