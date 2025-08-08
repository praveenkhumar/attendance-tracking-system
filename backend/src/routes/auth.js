// backend/src/routes/auth.js
const { User } = require("../models");
const { authService, faceService } = require("../services");
const { AppError } = require("../utils/errors");
const { validateEmail, validatePassword } = require("../utils/validation");

/**
 * Authentication Routes Plugin
 */
async function authRoutes(fastify, options) {
  // Login with face recognition
  fastify.post("/login", {
    schema: {
      body: {
        type: "object",
        required: ["email", "faceDescriptor"],
        properties: {
          email: { type: "string", format: "email" },
          faceDescriptor: {
            type: "array",
            items: { type: "number" },
            minItems: 128,
            maxItems: 128,
          },
          rememberMe: { type: "boolean", default: false },
        },
      },
    },
    preHandler: fastify.rateLimit({
      max: 5,
      timeWindow: "15 minutes",
      keyGenerator: (request) => request.ip,
      errorResponseBuilder: function (request, context) {
        return {
          error: "Rate limit exceeded",
          message: "Too many login attempts. Please try again later.",
          expiresIn: Math.round(context.ttl / 1000),
        };
      },
    }),
    handler: async (request, reply) => {
      const { email, faceDescriptor, rememberMe } = request.body;

      try {
        // Validate email format
        if (!validateEmail(email)) {
          throw new AppError("Invalid email format", 400);
        }

        // Find user by email
        const user = await User.findOne({
          email: email.toLowerCase(),
        }).select("+faceDescriptors +isActive");

        if (!user || !user.isActive) {
          throw new AppError("Invalid credentials", 401);
        }

        // Verify face recognition
        const isValidFace = await faceService.verifyFace(
          faceDescriptor,
          user.faceDescriptors
        );

        if (!isValidFace) {
          // Log failed attempt
          fastify.log.warn(
            `Failed face recognition login attempt for ${email}`,
            {
              userId: user._id,
              ip: request.ip,
              userAgent: request.headers["user-agent"],
            }
          );

          throw new AppError("Face recognition failed", 401);
        }

        // Update last login
        user.lastLogin = new Date();
        await user.save();

        // Create session
        const sessionData = await authService.createSession(user, {
          ip: request.ip,
          userAgent: request.headers["user-agent"],
          rememberMe,
        });

        // Set secure cookie
        const cookieOptions = {
          httpOnly: true,
          secure: process.env.NODE_ENV === "production",
          sameSite: "strict",
          maxAge: rememberMe ? 30 * 24 * 60 * 60 * 1000 : 24 * 60 * 60 * 1000, // 30 days or 1 day
          path: "/",
        };

        reply.setCookie("sessionToken", sessionData.token, cookieOptions);

        fastify.log.info(`Successful login for user ${user.email}`, {
          userId: user._id,
          sessionId: sessionData.sessionId,
        });

        return {
          success: true,
          message: "Login successful",
          user: {
            id: user._id,
            name: user.name,
            email: user.email,
            role: user.role,
            isFirstLogin: user.faceDescriptors.length === 0,
          },
          session: {
            expiresAt: sessionData.expiresAt,
          },
        };
      } catch (error) {
        if (error instanceof AppError) {
          throw error;
        }

        fastify.log.error("Login error:", error);
        throw new AppError("Authentication failed", 500);
      }
    },
  });

  // Register new user
  fastify.post("/register", {
    schema: {
      body: {
        type: "object",
        required: ["name", "email", "password"],
        properties: {
          name: { type: "string", minLength: 2, maxLength: 50 },
          email: { type: "string", format: "email" },
          password: { type: "string", minLength: 6 },
          department: { type: "string", maxLength: 50 },
          employeeId: { type: "string", maxLength: 20 },
        },
      },
    },
    preHandler: fastify.rateLimit({
      max: 3,
      timeWindow: "1 hour",
    }),
    handler: async (request, reply) => {
      const { name, email, password, department, employeeId } = request.body;

      try {
        // Validate inputs
        if (!validateEmail(email)) {
          throw new AppError("Invalid email format", 400);
        }

        if (!validatePassword(password)) {
          throw new AppError(
            "Password must be at least 6 characters long",
            400
          );
        }

        // Check if user already exists
        const existingUser = await User.findOne({
          $or: [
            { email: email.toLowerCase() },
            ...(employeeId ? [{ employeeId }] : []),
          ],
        });

        if (existingUser) {
          const field =
            existingUser.email === email.toLowerCase()
              ? "email"
              : "employee ID";
          throw new AppError(`User with this ${field} already exists`, 409);
        }

        // Create new user
        const userData = {
          name: name.trim(),
          email: email.toLowerCase(),
          password, // Will be hashed by pre-save middleware
          department: department?.trim(),
          employeeId: employeeId?.trim(),
          role: "employee", // Default role
          faceDescriptors: [], // Will be added later
          createdAt: new Date(),
        };

        const user = new User(userData);
        await user.save();

        fastify.log.info(`New user registered: ${user.email}`, {
          userId: user._id,
          department: user.department,
        });

        return {
          success: true,
          message: "Registration successful",
          user: {
            id: user._id,
            name: user.name,
            email: user.email,
            department: user.department,
            employeeId: user.employeeId,
          },
          nextStep: "face_registration",
        };
      } catch (error) {
        if (error instanceof AppError) {
          throw error;
        }

        if (error.code === 11000) {
          throw new AppError(
            "User with this email or employee ID already exists",
            409
          );
        }

        fastify.log.error("Registration error:", error);
        throw new AppError("Registration failed", 500);
      }
    },
  });

  // Logout
  fastify.post("/logout", {
    preHandler: [fastify.authenticate],
    handler: async (request, reply) => {
      try {
        const sessionToken = request.cookies.sessionToken;

        if (sessionToken) {
          await authService.revokeSession(sessionToken);
        }

        // Clear cookie
        reply.clearCookie("sessionToken", {
          httpOnly: true,
          secure: process.env.NODE_ENV === "production",
          sameSite: "strict",
          path: "/",
        });

        fastify.log.info(`User logged out: ${request.user.email}`, {
          userId: request.user.id,
        });

        return {
          success: true,
          message: "Logout successful",
        };
      } catch (error) {
        fastify.log.error("Logout error:", error);
        throw new AppError("Logout failed", 500);
      }
    },
  });

  // Refresh session
  fastify.post("/refresh", {
    preHandler: [fastify.authenticate],
    handler: async (request, reply) => {
      try {
        const currentToken = request.cookies.sessionToken;

        if (!currentToken) {
          throw new AppError("No session to refresh", 401);
        }

        // Create new session
        const sessionData = await authService.refreshSession(currentToken, {
          ip: request.ip,
          userAgent: request.headers["user-agent"],
        });

        // Set new cookie
        reply.setCookie("sessionToken", sessionData.token, {
          httpOnly: true,
          secure: process.env.NODE_ENV === "production",
          sameSite: "strict",
          maxAge: 24 * 60 * 60 * 1000, // 1 day
          path: "/",
        });

        return {
          success: true,
          message: "Session refreshed",
          expiresAt: sessionData.expiresAt,
        };
      } catch (error) {
        if (error instanceof AppError) {
          throw error;
        }

        fastify.log.error("Session refresh error:", error);
        throw new AppError("Session refresh failed", 500);
      }
    },
  });

  // Verify current session
  fastify.get("/verify", {
    preHandler: [fastify.authenticate],
    handler: async (request, reply) => {
      try {
        return {
          success: true,
          user: {
            id: request.user.id,
            name: request.user.name,
            email: request.user.email,
            role: request.user.role,
            department: request.user.department,
            employeeId: request.user.employeeId,
          },
          session: {
            expiresAt: request.sessionExpiresAt,
          },
        };
      } catch (error) {
        fastify.log.error("Session verification error:", error);
        throw new AppError("Session verification failed", 500);
      }
    },
  });

  // Request password reset (for admin use)
  fastify.post("/reset-password-request", {
    schema: {
      body: {
        type: "object",
        required: ["email"],
        properties: {
          email: { type: "string", format: "email" },
        },
      },
    },
    preHandler: fastify.rateLimit({
      max: 3,
      timeWindow: "1 hour",
    }),
    handler: async (request, reply) => {
      const { email } = request.body;

      try {
        // For security, always return success even if email doesn't exist
        const user = await User.findOne({ email: email.toLowerCase() });

        if (user) {
          // In a real application, you would:
          // 1. Generate a secure reset token
          // 2. Store it with expiration
          // 3. Send email with reset link

          fastify.log.info(`Password reset requested for: ${email}`, {
            userId: user._id,
            ip: request.ip,
          });
        }

        return {
          success: true,
          message:
            "If an account with that email exists, a reset link has been sent",
        };
      } catch (error) {
        fastify.log.error("Password reset request error:", error);
        throw new AppError("Request failed", 500);
      }
    },
  });
}

module.exports = authRoutes;
